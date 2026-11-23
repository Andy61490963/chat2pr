import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({ openaiKey: "fictional-classifier-key" }),
}));
import { db, reset, fixture } from "./helpers.js";
import { Triage, instructions, type Classifier } from "../server/triage.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { GitHub } from "../server/github.js";

beforeEach(async () => {
  await reset();
  const projectId = await fixture();
  await db.query(
    "INSERT INTO groups(id,name,enabled,trigger_mode) VALUES('group-b','另一個範例群組',true,'auto')",
  );
  await db.query(
    "INSERT INTO group_projects(group_id,project_id) VALUES('group-b',$1)",
    [projectId],
  );
});
afterAll(() => db.close());

const rejected = (
  title: string,
  {
    group = "group-a",
    reason = "not_for_ai",
    status = "rejected",
    daysAgo = 1,
  }: {
    group?: string;
    reason?: string | null;
    status?: string;
    daysAgo?: number;
  } = {},
) =>
  db.query(
    `INSERT INTO tasks(group_id,title,summary,status,end_reason,dedupe_key,updated_at)
     VALUES($1,$2,$2||'的摘要',$3,$4,$2,now()-make_interval(days=>$5::int))`,
    [group, title, status, reason, daysAgo],
  );

async function contextFor(triggerMode: "auto" | "command") {
  await db.query(
    "INSERT INTO messages(id,group_id,type,text,trigger_mode,received_at) VALUES('m1','group-a','text',$1,$2,now()-interval '3 minutes')",
    [
      triggerMode === "command" ? "/任務 調整範例看板配色" : "範例看板配色要調整",
      triggerMode,
    ],
  );
  const github = new GitHub();
  github.context = async () => ({
    sha: "fixture-base",
    paths: [],
    files: {},
    truncated: false,
    branches: { names: ["main"], defaultBranch: "main", truncated: false },
    branchError: null,
  });
  let seen: Record<string, unknown> | null = null;
  const classify: Classifier["classify"] = async ({ context }) => {
    seen = context as Record<string, unknown>;
    return [
      {
        kind: "ignore",
        noTaskReason: "no_actionable_request",
        projectId: null,
        title: "",
        summary: "",
        acceptance: [],
        sourceIds: ["m1"],
        risks: [],
        missing: [],
        relatedTaskId: null,
        suggestions: [],
      },
    ];
  };
  await new Triage(
    db,
    { classify },
    github,
    new Line(db),
    new Budget(db),
  ).process("group-a");
  expect(seen).not.toBeNull();
  return seen!;
}

describe("判讀參考同群組近期的拒絕案例", () => {
  it("只提供本群組 30 天內以「不是給 AI 的工作」「需求還沒定案」拒絕的需求，最新的 10 筆", async () => {
    for (let i = 1; i <= 11; i++)
      await rejected(`範例看板調整 ${i}`, {
        daysAgo: i,
        reason: i % 2 ? "not_for_ai" : "not_settled",
      });
    await rejected("小林自己整理的範例報表", {
      group: "group-b",
      daysAgo: 0,
    });
    await rejected("需求不清楚的範例", { reason: "unclear", daysAgo: 0 });
    await rejected("沒選原因的範例", { reason: null, daysAgo: 0 });
    await rejected("超過三十天的範例", { daysAgo: 31 });
    await rejected("重新開啟後待審核的範例", {
      status: "awaiting_approval",
      daysAgo: 0,
    });

    const context = await contextFor("auto");
    expect(context.recentRejections).toEqual(
      Array.from({ length: 10 }, (_, index) => ({
        title: `範例看板調整 ${index + 1}`,
        summary: `範例看板調整 ${index + 1}的摘要`,
        reason:
          (index + 1) % 2
            ? "不是給 AI 的工作（同事會自己處理）"
            : "需求還沒定案",
      })),
    );
  });

  it("沒有符合的拒絕案例時不放這個欄位", async () => {
    await rejected("另一群組的範例", { group: "group-b" });
    await rejected("超過三十天的範例", { daysAgo: 31 });
    await rejected("其他原因的範例", { reason: "other" });
    expect(await contextFor("auto")).not.toHaveProperty("recentRejections");
  });

  it("本批只有明確指令時不提供拒絕案例，/任務 不受影響", async () => {
    await rejected("範例看板調整");
    expect(await contextFor("command")).not.toHaveProperty(
      "recentRejections",
    );
  });

  it("判讀指示說明相似訊息歸為略過並留下原因，明確指令不受影響", () => {
    expect(instructions).toContain("context.recentRejections");
    expect(instructions).toContain(
      "kind=ignore、noTaskReason=similar_rejected",
    );
    expect(instructions).toContain(
      "triggerMode=command 的明確指令不受這條影響",
    );
  });
});
