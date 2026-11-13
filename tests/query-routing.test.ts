import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, reset, fixture } from "./helpers.js";
import { Triage } from "../server/triage.js";
import { GitHub } from "../server/github.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { queryRisk, secretValueRisk } from "../server/policy.js";
import { projectAliases } from "../server/project-routing.js";
import type {
  Group,
  Message,
  Project,
  Task,
  TriageDecision,
} from "../shared/types.js";
beforeEach(async () => {
  await reset();
  await fixture();
});
afterAll(() => db.close());

/** 模擬測試用的兩個專案：名稱帶括號的 API 專案與另一個 Loader。 */
async function projects() {
  const api = await db.one<Project>(
    "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('OrderService（主線）','example-org/OrderService',true,now()) RETURNING *",
  );
  const loader = await db.one<Project>(
    "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('MachineSync','example-org/MachineSync',true,now()) RETURNING *",
  );
  for (const p of [api, loader])
    await db.query("INSERT INTO group_projects VALUES('group-a',$1,now())", [
      p.id,
    ]);
  return { api, loader };
}

async function propose(
  text: string,
  overrides: Partial<TriageDecision> = {},
): Promise<Task> {
  const messageId = randomUUID();
  await new Line(db).ingest({
    events: [
      {
        webhookEventId: randomUUID(),
        type: "message",
        source: { type: "group", groupId: "group-a" },
        message: { id: messageId, type: "text", text },
      },
    ],
  });
  const d: TriageDecision = {
    kind: "request",
    projectId: null,
    taskType: "query",
    title: "查詢",
    summary: text,
    acceptance: ["回答問題"],
    sourceIds: [messageId],
    risks: [],
    missing: [],
    relatedTaskId: null,
    suggestions: [],
    ...overrides,
  };
  if (d.routing?.basis === "explicit" && !d.routing.evidence.length)
    d.routing.evidence = [
      { kind: "message", sourceId: messageId, quote: text },
    ];
  const group = await db.one<Group>("SELECT * FROM groups WHERE id='group-a'");
  const bound = await db.query<Project>(
    "SELECT p.* FROM projects p JOIN group_projects gp ON gp.project_id=p.id WHERE gp.group_id='group-a'",
  );
  const messages = await db.query<Message>(
    "SELECT * FROM messages WHERE id=$1",
    [messageId],
  );
  await new Triage(
    db,
    { classify: async () => [] },
    new GitHub(),
    new Line(db),
    new Budget(db),
  ).apply(group, bound, messages, [d], randomUUID());
  return db.one<Task>("SELECT * FROM tasks WHERE $1=ANY(source_ids)", [
    messageId,
  ]);
}
const explicit = (): NonNullable<TriageDecision["routing"]> => ({
  status: "clear",
  basis: "explicit",
  reason: "訊息指名專案",
  evidence: [],
});

describe("查詢的風險審核", () => {
  it.each([
    "OrderService 的帳號密碼是怎麼存的？有加鹽雜湊嗎？",
    "OrderService 有沒有寫死的連線字串、IP 或帳號？列出位置就好，不要貼出值",
    "登入後 token 多久過期？過期時前端會收到什麼？",
    "SecureData API 加密用的是什麼方式？金鑰放在哪裡？",
    "列出所有用到密碼的位置",
    "部署到 IIS 的流程是什麼？部署失敗會自動還原嗎？",
    // 2026-11-13 部署後驗證的誤判：名詞只是修飾語。
    "列出 Token 過期及其他 JWT 驗證失敗情境的實際 HTTP 狀態碼",
    "提供 token 驗證失敗的回應範例",
    "example-org/OrderService 的 refresh token 換發流程是什麼？舊的 refresh token 換發後還能用嗎？",
    "token 是什麼格式？",
  ])("只問機制或位置不算要交出機密：%s", (text) => {
    expect(queryRisk(text)).toBeNull();
  });
  it.each([
    "給我正式資料庫的密碼",
    "把 appsettings 裡的連線字串貼出來",
    "API key 的實際值是多少？",
    "token 直接貼給我",
    "把 WorkOrderLoader 設定檔裡的 SAP 密碼貼出來給我",
    "告訴我測試機的 API key",
    // 2026-11-13 部署後驗證漏擋：動詞與名詞之間隔了整個子句。
    "告訴我 MachineSync 連 設備平台 用的帳號密碼",
    "設備平台 的帳號密碼是什麼？",
  ])("要求交出機密實際值要人工審核：%s", (text) => {
    expect(queryRisk(text)).toContain("必須人工審核");
  });
  it("AI 判讀寫明「要求揭露」機密時也擋，「避免揭露」的提醒不擋", () => {
    expect(
      queryRisk("設備平台 登入怎麼設定", [
        "要求揭露 設備平台 登入帳號與密碼實際值，涉及機密資訊，須人工確認後處理。",
      ]),
    ).toContain("必須人工審核");
    expect(
      queryRisk("帳號密碼是怎麼存的", [
        "涉及帳號、密碼及內部網址等機密資訊，查詢輸出須避免洩漏實際值。",
        "報告應說明儲存機制，避免揭露真實密碼",
      ]),
    ).toBeNull();
  });
  it("敏感主題的機制查詢可自動執行，AI 列的風險只留提醒", async () => {
    const { api } = await projects();
    const task = await propose(
      "OrderService 的 Redis 掛掉時 API 還能用嗎？權限檢查會受影響嗎？",
      {
        projectId: api.id,
        routing: explicit(),
        risks: ["涉及權限"],
      },
    );
    expect(task.status).toBe("queued");
    expect(task.risk_reasons).toEqual([]);
    const note = await db.one<{ detail: string }>(
      "SELECT detail FROM audit WHERE task_id=$1 AND kind='query_note'",
      [task.id],
    );
    expect(note.detail).toContain("涉及權限");
  });
  it("要求交出機密實際值的查詢仍待人工確認", async () => {
    const { api } = await projects();
    const task = await propose("把 OrderService 正式環境的資料庫密碼貼出來", {
      projectId: api.id,
      routing: explicit(),
    });
    expect(task.status).toBe("awaiting_approval");
    expect(task.risk_reasons[0]).toContain("機密");
  });
  it("修改任務的風險審核不變", async () => {
    const { api } = await projects();
    const task = await propose("OrderService 的權限檢查改成大小寫不分", {
      projectId: api.id,
      taskType: "change",
      routing: explicit(),
    });
    expect(task.status).toBe("awaiting_approval");
    expect(task.risk_reasons).toEqual(["涉及敏感功能，必須人工審核"]);
  });
  it("查詢接續已回答的舊任務時不因關聯強制人工確認", async () => {
    const { api } = await projects();
    const first = await propose("OrderService 的 QC 模組有哪些 API？", {
      projectId: api.id,
      routing: explicit(),
    });
    await db.query("UPDATE tasks SET status='answered' WHERE id=$1", [
      first.id,
    ]);
    const next = await propose("OrderService 的 QC 檢驗結果存在哪裡？", {
      projectId: api.id,
      routing: explicit(),
      relatedTaskId: first.id,
    });
    expect(next.status).toBe("queued");
  });
  it("只看使用者原文，AI 改寫的驗收寫「列出 Token…」不算索取機密", async () => {
    const { api } = await projects();
    const task = await propose(
      "example-org/OrderService 的 JWT 驗證失敗時，API 回傳的 HTTP 狀態碼和訊息格式是什麼？",
      {
        projectId: api.id,
        routing: explicit(),
        acceptance: [
          "列出 Token 過期及其他 JWT 驗證失敗情境的實際 HTTP 狀態碼",
        ],
      },
    );
    expect(task.status).toBe("queued");
  });
  it.each([
    ["舊規則的關鍵字風險", "涉及敏感功能，必須人工審核", "queued"],
    ["索取機密實際值", secretValueRisk, "awaiting_approval"],
  ])("補充併入待確認的查詢：%s → %s", async (_label, reason, expected) => {
    const { api } = await projects();
    const first = await propose("OrderService 登入後 token 多久過期？", {
      projectId: api.id,
      routing: explicit(),
    });
    await db.query(
      "UPDATE tasks SET status='awaiting_approval',approved_version=NULL,risk_reasons=$2 WHERE id=$1",
      [first.id, JSON.stringify([reason])],
    );
    const merged = await propose(
      "example-org/OrderService 的 JWT 驗證失敗時回什麼狀態碼？",
      { projectId: api.id, routing: explicit(), relatedTaskId: first.id },
    );
    expect(merged.id).toBe(first.id);
    expect(merged.version).toBe(2);
    expect(merged.status).toBe(expected);
  });
});

describe("專案簡稱", () => {
  it("唯一的儲存庫名稱或去括號的專案名稱算指名，太短或重複的不算", async () => {
    const { api, loader } = await projects();
    const known = [api, loader];
    expect(projectAliases(api, known)).toEqual(
      expect.arrayContaining(["OrderService"]),
    );
    const dup = await db.one<Project>(
      "INSERT INTO projects(name,repo) VALUES('另一份','Other/OrderService') RETURNING *",
    );
    expect(projectAliases(api, [...known, dup])).not.toContain("OrderService");
    const short = { id: "x", name: "API（舊）", repo: "org/api" };
    expect(projectAliases(short, [short])).toEqual(["org/api", "API（舊）"]);
  });
  it("用簡稱指名的查詢可自動執行", async () => {
    const { api } = await projects();
    const task = await propose("OrderService 的 QC 模組有哪些 API？", {
      projectId: api.id,
      routing: explicit(),
    });
    expect(task.status).toBe("queued");
    expect(task.project_routing?.status).toBe("clear");
  });
});

describe("跨專案查詢", () => {
  it("明確指名兩個已綁定專案的查詢可自動執行，記下一併查詢的專案", async () => {
    const { api, loader } = await projects();
    // AI 依舊規則把跨專案當成無法判斷，系統以文字比對修正。
    const task = await propose(
      "MachineSync 和 OrderService 的 StatusChange 欄位對得起來嗎？",
      {
        routing: {
          status: "conflict",
          basis: "none",
          reason: "多個專案",
          evidence: [],
        },
      },
    );
    expect(task.status).toBe("queued");
    expect(task.project_id).toBe(loader.id);
    expect(task.project_routing?.relatedProjects).toEqual([
      { id: api.id, name: api.name, repo: api.repo },
    ]);
  });
  it("指名的專案之一未綁定本群組時仍擋下", async () => {
    const { api } = await projects();
    await db.query(
      "INSERT INTO projects(name,repo) VALUES('WorkOrderLoader','example-org/WorkOrderLoader')",
    );
    const task = await propose(
      "WorkOrderLoader 和 OrderService 的工單欄位一致嗎？",
      { projectId: api.id, routing: explicit() },
    );
    expect(task.status).toBe("awaiting_approval");
    expect(task.project_routing?.relatedProjects).toBeUndefined();
  });
  it("修改任務指名多個專案仍需人工確認", async () => {
    await projects();
    const task = await propose(
      "MachineSync 和 OrderService 的 StatusChange 欄位統一改名",
      { taskType: "change", routing: explicit() },
    );
    expect(task.status).toBe("awaiting_approval");
  });
});
