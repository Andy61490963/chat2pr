import { afterAll, beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { db, reset, fixture } from "./helpers.js";
import {
  getTaskImages,
  validateTaskImages,
  taskImageEvidence,
  saveImageObservations,
  imageHash,
  validateTaskSources,
  type ImageObservationDraft,
} from "../server/image-context.js";
import {
  Triage,
  type Classifier,
  type Classification,
} from "../server/triage.js";
import { Retrieval } from "../server/retrieval.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { GitHub } from "../server/github.js";
import { cleanup, backupTables } from "../server/maintenance.js";
import { readTaskContextEvidence } from "../server/task-context.js";
import type { Message, Task, TriageDecision } from "../shared/types.js";

beforeEach(reset);
afterAll(() => db.close());
const vector = () => {
  const v = Array<number>(1024).fill(0);
  v[0] = 1;
  return v;
};
const embedder = () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(vector)),
});
const turnOn = () =>
  db.query("UPDATE settings SET value=jsonb_set(value,'{rag_enabled}','true')");
const github = new GitHub();
github.context = async () => ({
    branches: {names:["main"],defaultBranch:"main",truncated:false}, branchError: null,
  sha: "test-base",
  paths: [],
  files: {},
  truncated: false,
});
function triage(
  classify: Classifier["classify"],
  retrieval = new Retrieval(db, embedder()),
) {
  return new Triage(
    db,
    { classify },
    github,
    new Line(db),
    new Budget(db),
    retrieval,
  );
}
const decision = (
  ids: string[],
  extra: Partial<TriageDecision> = {},
): TriageDecision => ({
  kind: "request",
  projectId: null,
  title: "調整青鳥看板",
  summary: "依青鳥看板截圖調整欄寬",
  acceptance: ["欄寬為 360px"],
  sourceIds: ids,
  risks: [],
  missing: [],
  relatedTaskId: null,
  suggestions: [],
  ...extra,
});
const observation = (
  id: string,
  extra: Partial<ImageObservationDraft> = {},
): ImageObservationDraft => ({
  sourceId: id,
  summary: "青鳥看板截圖，欄寬標記 360px",
  text: "青鳥欄位 360px",
  uncertainties: [],
  intent: "reference",
  ...extra,
});
async function imageMessage(
  id: string,
  days = 0,
  group = "group-a",
  processed = false,
  mime = "image/png",
) {
  const source = sharp({
    create: { width: 8, height: 8, channels: 3, background: "#245a80" },
  });
  const bytes = await (
    mime === "image/gif" ? source.gif() : source.png()
  ).toBuffer();
  await db.query(
    "INSERT INTO messages(id,group_id,type,image,image_mime,received_at,processed) VALUES($1,$2,'image',$3,$4,now()-make_interval(days=>$5),$6)",
    [id, group, bytes, mime, days, processed],
  );
  return (await db.one<Message>("SELECT * FROM messages WHERE id=$1", [id]))!;
}
async function observedImage(id: string, days = 7, group = "group-a") {
  const m = await imageMessage(id, days, group, true);
  await db.transaction((c) => saveImageObservations(c, [m], [observation(id)]));
  return m;
}
async function message(id: string, text: string, quote?: string) {
  await new Line(db).ingest({
    events: [
      {
        webhookEventId: "event-" + id,
        type: "message",
        source: { type: "group", groupId: "group-a" },
        message: { id, type: "text", text, quotedMessageId: quote },
      },
    ],
  });
  await db.query(
    "UPDATE groups SET first_pending_at=now()-interval '6 minutes' WHERE id='group-a'",
  );
}
async function imageTask(id = "picture") {
  await fixture();
  const m = await imageMessage(id);
  await message("request", "請照這張青鳥圖調整欄位為 360px", id);
  await triage(async () =>
    Object.assign(
      [
        decision(["request", id], {
          imageSourceIds: [id],
          imageReferenceResolution: "unique",
        }),
      ],
      { observations: [observation(id, { intent: "change_request" })] },
    ),
  ).process("group-a");
  return { m, task: (await db.one<Task>("SELECT * FROM tasks"))! };
}

it("單純貼圖同次辨識保存觀察，不產生任務或第二次 AI 呼叫", async () => {
  await fixture();
  await turnOn();
  const m = await imageMessage("reference");
  const classify = vi.fn(async () =>
    Object.assign([decision([m.id])], { observations: [observation(m.id)] }),
  );
  await triage(classify).process("group-a");
  expect(classify).toHaveBeenCalledTimes(1);
  expect(await db.query("SELECT id FROM tasks")).toHaveLength(0);
  expect(
    await db.one("SELECT source_hash,summary FROM image_observations"),
  ).toEqual({
    source_hash: imageHash(m.image!),
    summary: observation(m.id).summary,
  });
  const r = new Retrieval(db, embedder());
  await r.indexBatch();
  expect(await db.one("SELECT kind,content FROM embeddings")).toEqual({
    kind: "image",
    content: null,
  });
  expect(backupTables).not.toContain("image_observations");
  expect(backupTables).not.toContain("task_context_evidence");
});

it("指令模式的一般圖片只顯示於聊天室，不呼叫分類也不產生觀察", async () => {
  await fixture();
  await db.query("UPDATE groups SET trigger_mode='command'");
  await new Line(db).ingest({
    events: [
      {
        webhookEventId: "ordinary-image",
        type: "message",
        source: { type: "group", groupId: "group-a" },
        message: { id: "ordinary", type: "image" },
      },
    ],
  });
  const classify = vi.fn(async () => [] as Classification);
  await triage(classify).process("group-a");
  expect(classify).not.toHaveBeenCalled();
  expect(await db.query("SELECT * FROM image_observations")).toHaveLength(0);
});

it("七天前圖片不在近期對話，經向量找回後原圖與可信雜湊固定至任務版本", async () => {
  const p = await fixture();
  await turnOn();
  const old = await observedImage("old-picture");
  await db.query(
    "INSERT INTO groups(id,name,enabled) VALUES('foreign','別群',true)",
  );
  await db.query(
    "INSERT INTO group_projects(group_id,project_id) VALUES('foreign',$1)",
    [p],
  );
  await observedImage("foreign-picture", 7, "foreign");
  const r = new Retrieval(db, embedder());
  await r.indexBatch();
  expect((await r.lookup("group-a", "青鳥", [], [p], false)).hits).toHaveLength(
    0,
  );
  expect(
    (await r.lookup("group-a", "青鳥", [], [p], true)).hits.map((h) => h.id),
  ).toEqual([old.id]);
  await message("request", "請依七天前青鳥截圖調寬欄位");
  const classify: Classifier["classify"] = async (input) => {
    expect(
      JSON.stringify(
        (input.context as { recentConversation: unknown }).recentConversation,
      ),
    ).not.toContain(old.id);
    expect(input.messages.find((m) => m.id === old.id)).toMatchObject({
      contextOnly: true,
      contextOrigin: "rag",
    });
    expect(input.messages.map((m) => m.id)).not.toContain("foreign-picture");
    return [
      decision(["request"], {
        imageSourceIds: [old.id],
        imageReferenceResolution: "unique",
      }),
    ];
  };
  await triage(classify, r).process("group-a");
  const task = (await db.one<Task>("SELECT * FROM tasks"))!;
  expect(task.status).toBe("awaiting_approval");
  expect(task.source_ids).toEqual(["request", old.id]);
  const images = await getTaskImages(db, task.id, 1);
  expect(images).toHaveLength(1);
  expect(images[0]).toMatchObject({
    id: old.id,
    origin: "rag",
    sha256: imageHash(old.image!),
    modelSha256: imageHash(old.image!),
  });
  expect(Buffer.from(images[0].data, "base64")).toEqual(old.image);
  expect(await readTaskContextEvidence(db, task.id)).toContainEqual(
    expect.objectContaining({
      mechanism: "vector",
      source_kind: "image",
      source_id: old.id,
      source_hash: imageHash(old.image!),
      valid: true,
    }),
  );
});

it("兩張候選無法唯一指認時不得隨便選圖，改為人工確認", async () => {
  await fixture();
  await turnOn();
  await observedImage("left");
  await observedImage("right");
  const r = new Retrieval(db, embedder());
  await r.indexBatch();
  await message("request", "請依上次那張圖調整");
  await triage(
    async () => [
      decision(["request", "left"], {
        imageSourceIds: ["left"],
        imageReferenceResolution: "ambiguous",
      }),
    ],
    r,
  ).process("group-a");
  const task = (await db.one<Task>("SELECT * FROM tasks"))!;
  expect(task.status).toBe("awaiting_approval");
  expect(task.source_ids).toEqual(["request"]);
  expect(task.missing.join()).toContain("唯一");
  expect(await getTaskImages(db, task.id, 1)).toHaveLength(0);
});

it("引用其他群組或非候選圖片會保留訊息並拒絕派工", async () => {
  await fixture();
  await message("request", "調寬欄位");
  await expect(
    triage(async () => [
      decision(["request"], {
        imageSourceIds: ["untrusted"],
        imageReferenceResolution: "unique",
      }),
    ]).process("group-a"),
  ).rejects.toThrow("圖片引用不屬於");
  expect((await db.one("SELECT processed FROM messages")).processed).toBe(
    false,
  );
  expect(await db.query("SELECT * FROM tasks")).toHaveLength(0);
});

it("圖片需求改版複製原始雜湊，舊版不能執行，改圖不能冒用已核准版本", async () => {
  const { m, task } = await imageTask();
  await db.query("UPDATE tasks SET version=2 WHERE id=$1", [task.id]);
  await expect(validateTaskImages(db, task.id, 1)).rejects.toThrow("版本");
  await expect(validateTaskImages(db, task.id, 2)).resolves.toBeUndefined();
  expect(
    await db.query(
      "SELECT task_version,source_hash FROM task_image_refs ORDER BY task_version",
    ),
  ).toEqual([
    { task_version: 1, source_hash: imageHash(m.image!) },
    { task_version: 2, source_hash: imageHash(m.image!) },
  ]);
  const replacement = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await db.query("UPDATE messages SET image=$2 WHERE id=$1", [
    m.id,
    replacement,
  ]);
  await expect(getTaskImages(db, task.id, 2)).rejects.toThrow("內容已變更");
  expect(await taskImageEvidence(db, task.id, 2)).toContainEqual(
    expect.objectContaining({ valid: false, observation: null }),
  );
  expect(await db.query("SELECT * FROM image_observations")).toHaveLength(0);
});

it("撤回使觀察、向量與推論中票券立即失效，不能恢復舊結果或讀到原圖", async () => {
  const { task } = await imageTask();
  await turnOn();
  await db.query("UPDATE image_observations SET updated_at=now()");
  const r = new Retrieval(db, {
    embed: async (texts) => {
      await new Line(db).ingest({
        events: [
          {
            webhookEventId: "withdraw",
            type: "unsend",
            source: { type: "group", groupId: "group-a" },
            unsend: { messageId: "picture" },
          },
        ],
      });
      return texts.map(vector);
    },
  });
  await r.indexBatch();
  await expect(getTaskImages(db, task.id, 1)).rejects.toThrow("版本");
  const current = (await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
    task.id,
  ]))!;
  await expect(getTaskImages(db, task.id, current.version)).rejects.toThrow(
    "撤回",
  );
  for (const table of ["image_observations", "embeddings", "rag_pending"])
    expect(
      await db.query(
        `SELECT * FROM ${table} ${table !== "image_observations" ? "WHERE kind='image'" : ""}`,
      ),
    ).toHaveLength(0);
  expect(await taskImageEvidence(db, task.id, current.version)).toContainEqual(
    expect.objectContaining({ valid: false, observation: null }),
  );
});

it("縮短保存期後未等清理即不可讀取圖片摘要，清理刪除衍生內容", async () => {
  const { task } = await imageTask();
  await db.query(
    "UPDATE messages SET received_at=now()-interval '7 days' WHERE type='image'",
  );
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{retention_days}','1')",
  );
  await expect(validateTaskImages(db, task.id, 1)).rejects.toThrow("到期");
  expect(await taskImageEvidence(db, task.id, 1)).toContainEqual(
    expect.objectContaining({ valid: false, observation: null }),
  );
  expect(
    await db.query("SELECT * FROM rag_sources WHERE kind='image'"),
  ).toHaveLength(0);
  await cleanup(db);
  expect(await db.query("SELECT * FROM image_observations")).toHaveLength(0);
  expect(
    (await db.one("SELECT image FROM messages WHERE type='image'")).image,
  ).toBeNull();
});

it("群組停用或移除專案綁定後不可繼續取得來源圖片與觀察", async () => {
  const { task } = await imageTask();
  await db.query("DELETE FROM group_projects");
  await expect(validateTaskImages(db, task.id, 1)).rejects.toThrow("版本已更新");
  await expect(taskImageEvidence(db, task.id, 1)).rejects.toThrow("版本已更新");
});

it("GIF 保留原始雜湊，模型使用可驗證的首幀 PNG", async () => {
  await fixture();
  const m = await imageMessage("gif", 0, "group-a", false, "image/gif");
  await message("request", "請依圖調整欄寬", m.id);
  await triage(async () =>
    Object.assign([decision(["request", m.id])], {
      observations: [observation(m.id)],
    }),
  ).process("group-a");
  const task = (await db.one<Task>("SELECT * FROM tasks"))!;
  const [image] = await getTaskImages(db, task.id, 1);
  expect(image).toMatchObject({
    mime: "image/png",
    originalMime: "image/gif",
    sha256: imageHash(m.image!),
  });
  expect(image.modelSha256).toBe(imageHash(Buffer.from(image.data, "base64")));
  expect(image.modelSha256).not.toBe(image.sha256);
});

it("向量模型離線仍能處理與舊圖無關的新文字需求", async () => {
  await fixture();
  await turnOn();
  await message("request", "把頁尾文字改成青鳥");
  const r = new Retrieval(db, {
    embed: async () => {
      throw Error("模型離線");
    },
  });
  await triage(async () => [decision(["request"])], r).process("group-a");
  expect((await db.one("SELECT status FROM tasks")).status).toBe("awaiting_approval");
  expect(
    (await db.one("SELECT ok FROM service_health WHERE name='retrieval'")).ok,
  ).toBe(false);
});

it("模型離線須明確告知分類器，依賴缺失歷史圖片的要求不得猜測派工", async () => {
  await fixture();
  await turnOn();
  await message("request", "請照昨天那張圖調整");
  const r = new Retrieval(db, {
    embed: async () => {
      throw Error("模型離線");
    },
  });
  await triage(async (input) => {
    expect(input.context).toMatchObject({
      retrievalStatus: {
        enabled: true,
        available: false,
        reason: "檢索暫時失敗",
      },
    });
    return [decision(["request"])];
  }, r).process("group-a");
  const task = (await db.one<Task>("SELECT * FROM tasks"))!;
  expect(task.status).toBe("awaiting_approval");
  expect(task.missing.join()).toContain("歷史圖片尚未確認");
});

it("向量候選超過上限會揭露省略來源，不因只載入部分圖片就假稱唯一", async () => {
  await fixture();
  await turnOn();
  for (const id of ["one", "two", "three", "four"]) await observedImage(id);
  const r = new Retrieval(db, embedder());
  await r.indexBatch();
  await message("request", "請照之前那張青鳥圖調整");
  await triage(async (input) => {
    const context = input.context as {
      omittedImageCandidates: string[];
      contextLimits: Record<string, unknown>;
    };
    expect(context.omittedImageCandidates).toHaveLength(1);
    expect(context.contextLimits.imageCandidates).toMatchObject({
      truncated: true,
    });
    const selected = input.messages.find((m) => m.contextOrigin === "rag")!;
    return [
      decision(["request"], {
        imageSourceIds: [selected.id],
        imageReferenceResolution: "unique",
      }),
    ];
  }, r).process("group-a");
  const task = (await db.one<Task>("SELECT * FROM tasks"))!;
  expect(task.status).toBe("awaiting_approval");
  expect(await getTaskImages(db, task.id, 1)).toHaveLength(0);
});

it("近期訊息與任務超過上限時，分類及稽核能看到實際截斷", async () => {
  const p = await fixture();
  await db.query(
    "INSERT INTO messages(id,group_id,type,text,processed) SELECT 'history-'||n,'group-a','text','一般對話',true FROM generate_series(1,301) n",
  );
  await db.query(
    "INSERT INTO tasks(group_id,project_id,title,summary,dedupe_key,status) SELECT 'group-a',$1,'舊任務','摘要','old-'||n,'merged' FROM generate_series(1,201) n",
    [p],
  );
  await message("request", "把頁尾改成青鳥");
  await triage(async (input) => {
    expect(input.tasks).toHaveLength(200);
    expect(input.context).toMatchObject({
      contextLimits: {
        recentConversation: { limit: 300, truncated: true },
        existingTasks: { limit: 200, truncated: true },
      },
    });
    expect(
      (input.context as { recentConversation: unknown[] }).recentConversation,
    ).toHaveLength(300);
    return [decision(["request"])];
  }).process("group-a");
  expect(
    (
      await db.one(
        "SELECT detail FROM audit WHERE kind='retrieval' ORDER BY id DESC LIMIT 1",
      )
    ).detail,
  ).toContain("近期對話只取最近 300 則");
});

it("舊文字只把模型實際採用來源納入需求版本，候選來源保持分開", async () => {
  await fixture();
  await turnOn();
  await db.query(
    "INSERT INTO messages(id,group_id,type,text,processed,received_at) VALUES('adopted','group-a','text','青鳥規格欄寬 397px',true,now()-interval '7 days'),('candidate','group-a','text','青鳥另一個待辦',true,now()-interval '7 days')",
  );
  const r = new Retrieval(db, embedder());
  await r.indexBatch();
  await message("request", "請依上週青鳥欄寬規格調整");
  await triage(
    async () => [decision(["request"], { contextSourceIds: ["adopted"] })],
    r,
  ).process("group-a");
  const task = (await db.one<Task>("SELECT * FROM tasks"))!;
  expect(task.source_ids).toEqual(["request", "adopted"]);
  const evidence = await readTaskContextEvidence(db, task.id);
  expect(
    evidence
      .filter((e) => e.phase === "triage-selected")
      .map((e) => e.source_id),
  ).toEqual(["adopted"]);
  expect(
    evidence.some((e) => e.phase === "triage" && e.source_id === "candidate"),
  ).toBe(true);
  await validateTaskSources(db, task.id, 1);
  await db.query("UPDATE tasks SET version=2 WHERE id=$1", [task.id]);
  await validateTaskSources(db, task.id, 2);
  await db.query(
    "UPDATE messages SET text='青鳥規格欄寬 800px' WHERE id='adopted'",
  );
  await expect(validateTaskSources(db, task.id, 2)).rejects.toThrow(
    "內容已變更",
  );
});

it("依賴歷史規格但沒有選來源時待確認，閒聊不會因舊命中而變任務", async () => {
  await fixture();
  await turnOn();
  await db.query(
    "INSERT INTO messages(id,group_id,type,text,processed,received_at) VALUES('history','group-a','text','青鳥規格欄寬 397px',true,now()-interval '7 days')",
  );
  const r = new Retrieval(db, embedder());
  await r.indexBatch();
  await message("request", "請依上週青鳥欄寬規格調整");
  await triage(async () => [decision(["request"])], r).process("group-a");
  expect((await db.one<Task>("SELECT * FROM tasks"))!.status).toBe(
    "awaiting_approval",
  );
  await message("chat", "照上次的規格來看大家真的辛苦了，早安！");
  await triage(
    async () => [decision(["chat"], { kind: "ignore", contextSourceIds: [] })],
    r,
  ).process("group-a");
  expect(await db.query("SELECT id FROM tasks")).toHaveLength(1);
});
