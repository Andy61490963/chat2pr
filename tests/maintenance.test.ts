import { beforeEach, afterAll, it, expect, vi } from "vitest";
vi.mock("../server/config.js", async (original) => {
  const actual = await original<typeof import("../server/config.js")>();
  return {
    ...actual,
    secrets: () => ({ sessionSecret: "fictional-backup-key" }),
    config: () => ({
      ...actual.config(),
      dataDir: process.env.TEST_BACKUP_DIR!,
    }),
  };
});
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, reset, fixture, testUrl } from "./helpers.js";
import { Retrieval, requestBackfill } from "../server/retrieval.js";
import {
  cleanup,
  backup,
  decodeBackup,
  downloadPendingImages,
} from "../server/maintenance.js";
beforeEach(reset);
afterAll(() => db.close());
it("到期原文與圖片清除；加密備份保留摘要而不納入來源或憑證", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentflow-test-"));
  process.env.TEST_BACKUP_DIR = dir;
  try {
    const project = await fixture();
    await db.query(
      "INSERT INTO messages(id,group_id,type,text,image,user_id,received_at) VALUES('expired','group-a','image','不應保留的原文',$1,'使用者',now()-interval '31 days')",
      [Buffer.from("image")],
    );
    await db.query(
      "INSERT INTO tasks(project_id,group_id,title,summary,dedupe_key) VALUES($1,'group-a','需求摘要','保留的驗收摘要','retention')",
      [project],
    );
    const question = {
      text: "要保留哪個日期格式？",
      choices: ["西元年", "民國年"],
    };
    await db.query("UPDATE tasks SET question=$1,assumptions=$2", [
      JSON.stringify(question),
      JSON.stringify(["保留原有欄位順序"]),
    ]);
    await db.query(
      "INSERT INTO group_memories(group_id,project_id,content,source) VALUES('group-a',$1,'報工指向本專案','manual')",
      [project],
    );
    await db.query(
      "INSERT INTO project_knowledge(group_id,project_id,content,source) VALUES('group-a',$1,'報表使用本地日期','manual')",
      [project],
    );
    await db.query(
      "INSERT INTO messages(id,group_id,type,text) VALUES('live','group-a','text','不可備份的原始對話')",
    );
    await db.query(
      "INSERT INTO members(github_id,login,role,added_by) VALUES('900001','fictional-admin','admin','owner'),('900002','fictional-member','member','fictional-admin')",
    );
    await cleanup(db);
    expect(
      await db.one(
        "SELECT text,image,user_id FROM messages WHERE id='expired'",
      ),
    ).toEqual({
      text: null,
      image: null,
      user_id: null,
    });
    const file = join(dir, "backups", await backup(db));
    expect((await readFile(file)).toString()).not.toContain("保留的驗收摘要");
    const decoded = await decodeBackup(file);
    expect(decoded.version).toBe(4);
    expect(decoded.tables.tasks[0].question).toEqual(question);
    expect(decoded.tables.tasks[0].assumptions).toEqual(["保留原有欄位順序"]);
    expect(decoded.tables.tasks[0].summary).toBe("保留的驗收摘要");
    expect(decoded.tables.embeddings).toBeUndefined();
    expect(decoded.tables.messages).toBeUndefined();
    expect(decoded.tables.sessions).toBeUndefined();
    expect(decoded.tables.runs).toBeUndefined();
    expect(JSON.stringify(decoded.tables)).not.toContain("不可備份的原始對話");

    const secretFile = join(dir, "test-secrets.json");
    await writeFile(
      secretFile,
      JSON.stringify({ sessionSecret: "fictional-backup-key" }),
    );
    const restore = (path: string) =>
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "scripts/restore.ts", path],
        {
          env: {
            ...process.env,
            DATABASE_URL: testUrl,
            SECRETS_FILE: secretFile,
          },
        },
      );
    const emptyDestination = async () => {
      await reset();
      await db.query("DELETE FROM service_health");
    };
    await emptyDestination();
    await restore(file);
    expect(await db.one("SELECT question,assumptions FROM tasks")).toEqual({
      question,
      assumptions: ["保留原有欄位順序"],
    });
    expect(
      await db.query("SELECT group_id,project_id FROM group_projects"),
    ).toEqual([{ group_id: "group-a", project_id: project }]);
    expect(await db.one("SELECT content FROM group_memories")).toEqual({
      content: "報工指向本專案",
    });
    expect(await db.one("SELECT content FROM project_knowledge")).toEqual({
      content: "報表使用本地日期",
    });
    // 成員名單與角色一併還原，不必逐一重新加入。
    expect(
      await db.query(
        "SELECT github_id,login,role,added_by FROM members ORDER BY github_id",
      ),
    ).toEqual([
      {
        github_id: "900001",
        login: "fictional-admin",
        role: "admin",
        added_by: "owner",
      },
      {
        github_id: "900002",
        login: "fictional-member",
        role: "member",
        added_by: "fictional-admin",
      },
    ]);
    expect(await db.query("SELECT id FROM messages")).toHaveLength(0);
    expect(await db.query("SELECT id FROM embeddings")).toHaveLength(0);
    expect((await db.settings()).paused).toBe(true);
    await requestBackfill(db);
    const retrieval = new Retrieval(db, {
      embed: async (inputs) => inputs.map(() => Array(1024).fill(1)),
    });
    await retrieval.indexBatch();
    expect(await db.query("SELECT kind FROM embeddings ORDER BY kind")).toEqual(
      [{ kind: "knowledge" }, { kind: "memory" }, { kind: "task" }],
    );

    const encrypt = async (name: string, snapshot: unknown) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv(
        "aes-256-gcm",
        createHash("sha256").update("fictional-backup-key").digest(),
        iv,
      );
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(snapshot)),
        cipher.final(),
      ]);
      const path = join(dir, name);
      await writeFile(
        path,
        Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
      );
      return path;
    };

    // 納入成員名單之前產生的備份仍可還原：其餘資料照舊，成員名單留空並提示重新加入。
    const previous = structuredClone(decoded);
    previous.version = 2;
    delete previous.tables.tasks[0].question;
    delete previous.tables.tasks[0].assumptions;
    delete previous.tables.members;
    await emptyDestination();
    const { stdout } = await restore(
      await encrypt("previous.afbackup", previous),
    );
    expect(stdout).toContain("這份備份沒有成員名單");
    expect(stdout).toContain("沒有結構化的補問與假設");
    expect(await db.one("SELECT question,assumptions FROM tasks")).toEqual({
      question: null,
      assumptions: [],
    });
    expect(await db.query("SELECT github_id FROM members")).toHaveLength(0);
    expect(await db.one("SELECT summary FROM tasks")).toEqual({
      summary: "保留的驗收摘要",
    });

    // 新格式的備份少了成員名單就是不完整，不能當成空名單還原。
    const broken = structuredClone(decoded);
    delete broken.tables.members;
    await emptyDestination();
    await expect(
      restore(await encrypt("broken.afbackup", broken)),
    ).rejects.toThrow("備份資料表不完整");
    expect(await db.query("SELECT id FROM tasks")).toHaveLength(0);

    // 重現舊版加密備份：只有群組欄位記錄單一專案，且沒有後續遷移的欄位。
    const old = structuredClone(decoded);
    old.version = 1;
    for (const key of [
      "members",
      "group_projects",
      "group_memories",
      "project_knowledge",
      "rag_references",
    ])
      delete old.tables[key];
    old.tables.groups[0].project_id = project;
    delete old.tables.projects[0].config_version;
    delete old.tables.settings[0].value.rag_enabled;
    const legacyFile = await encrypt("legacy.afbackup", old);
    await emptyDestination();
    await restore(legacyFile);
    expect(
      await db.query("SELECT group_id,project_id FROM group_projects"),
    ).toEqual([{ group_id: "group-a", project_id: project }]);
    expect(await db.one("SELECT config_version FROM projects")).toEqual({
      config_version: 1,
    });
    expect((await db.settings()).rag_enabled).toBe(false);
  } finally {
    if (!dir.startsWith(join(tmpdir(), "agentflow-test-")))
      throw Error("清理路徑錯誤");
    await rm(dir, { recursive: true, force: true });
    delete process.env.TEST_BACKUP_DIR;
  }
});

it("短保存期排除到期圖片；下載途中到期的圖片不寫回", async () => {
  await fixture();
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{retention_days}','3')",
  );
  await db.query(`INSERT INTO messages(id,group_id,type,received_at) VALUES
    ('expired','group-a','image',now()-interval '4 days'),
    ('in-flight','group-a','image',now()-interval '2 days'),
    ('live','group-a','image',now())`);
  const image = vi.fn(async (id: string) => {
    if (id === "in-flight")
      await db.query(
        "UPDATE settings SET value=jsonb_set(value,'{retention_days}','1')",
      );
    return { data: Buffer.from("test-image"), mime: "image/png" };
  });
  await downloadPendingImages(db, { image });
  expect(image.mock.calls.map(([id]) => id)).toEqual(["in-flight", "live"]);
  expect(
    await db.query("SELECT id FROM messages WHERE image IS NOT NULL"),
  ).toEqual([{ id: "live" }]);
});
