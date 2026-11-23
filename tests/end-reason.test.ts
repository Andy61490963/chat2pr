import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";

let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  await reset();
  await fixture();
  app = await buildApp(db);
});
afterEach(() => app.close());
afterAll(() => db.close());

const task = (key: string, status = "awaiting_approval") =>
  db.one<{ id: string }>(
    "INSERT INTO tasks(group_id,title,summary,status,dedupe_key) VALUES('group-a','範例報表欄位','把範例報表加上日期欄',$1,$2) RETURNING id",
    [status, key],
  );
const act = async (id: string, payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/api/tasks/${id}/actions`,
    headers: await session(),
    payload: { version: 1, ...payload },
  });
const ended = (id: string) =>
  db.one<{ status: string; end_reason: string | null }>(
    "SELECT status,end_reason FROM tasks WHERE id=$1",
    [id],
  );
const audits = (id: string) =>
  db.query<{ kind: string; detail: string }>(
    "SELECT kind,detail FROM audit WHERE task_id=$1 ORDER BY created_at,id",
    [id],
  );
const detail = async (id: string) =>
  (
    await app.inject({ url: `/api/tasks/${id}`, headers: await session() })
  ).json();

describe("拒絕時記錄原因", () => {
  it("拒絕帶原因與補充時寫入任務與稽核，任務詳情的結束摘要看得到", async () => {
    const t = await task("reason-1");
    const response = await act(t.id, {
      action: "reject",
      end_reason: "not_for_ai",
      reason: "小林會自己處理",
    });
    expect(response.statusCode).toBe(200);
    expect(await ended(t.id)).toEqual({
      status: "rejected",
      end_reason: "not_for_ai",
    });
    const [audit] = await audits(t.id);
    expect(audit.kind).toBe("reject");
    expect(audit.detail).toMatch(
      /拒絕（需求版本 1；目標分支 待選擇），原因：不是給 AI 的工作（同事會自己處理）；小林會自己處理$/,
    );
    const shown = await detail(t.id);
    expect(shown.task.end_summary).toMatchObject({
      kind: "reject",
      reason: "不是給 AI 的工作（同事會自己處理）；小林會自己處理",
    });
    expect(
      shown.history.some((a: { detail: string }) =>
        a.detail.includes("原因：不是給 AI 的工作"),
      ),
    ).toBe(true);
  });

  it("不帶原因時與舊版相同：照樣拒絕，任務沒有原因、稽核不寫原因", async () => {
    const t = await task("reason-2");
    expect((await act(t.id, { action: "reject" })).statusCode).toBe(200);
    expect(await ended(t.id)).toEqual({ status: "rejected", end_reason: null });
    const [audit] = await audits(t.id);
    expect(audit.detail).toMatch(/拒絕（需求版本 1；目標分支 待選擇）$/);
  });

  it("不認得的原因代碼退回 400，任務維持待審核", async () => {
    const t = await task("reason-3");
    const response = await act(t.id, {
      action: "reject",
      end_reason: "dislike",
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("請選擇有效的拒絕原因");
    expect(await ended(t.id)).toEqual({
      status: "awaiting_approval",
      end_reason: null,
    });
  });

  it("補充含憑證時拒絕送出，不寫進稽核", async () => {
    const t = await task("reason-4");
    const response = await act(t.id, {
      action: "reject",
      end_reason: "other",
      reason: "密碼：fictional-pass-123",
    });
    expect(response.statusCode).toBe(422);
    expect(await audits(t.id)).toEqual([]);
  });

  it("重新開啟後清除原因，再拒絕不帶原因時不沿用舊原因", async () => {
    const t = await task("reason-5");
    await act(t.id, { action: "reject", end_reason: "not_settled" });
    expect((await act(t.id, { action: "reopen" })).statusCode).toBe(200);
    expect(await ended(t.id)).toEqual({
      status: "awaiting_approval",
      end_reason: null,
    });
    expect(
      (await act(t.id, { action: "reject", version: 2 })).statusCode,
    ).toBe(200);
    expect(await ended(t.id)).toEqual({ status: "rejected", end_reason: null });
  });

  it("批次結束帶原因時，拒絕與取消的任務都記下同一個原因", async () => {
    const pending = await task("batch-1");
    const failed = await task("batch-2", "failed");
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/batch-end",
      headers: await session(),
      payload: {
        tasks: [
          { id: pending.id, version: 1, status: "awaiting_approval" },
          { id: failed.id, version: 1, status: "failed" },
        ],
        end_reason: "duplicate",
        reason: "和範例群組上週的需求相同",
        notify: false,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ended: 2, skipped: 0 });
    expect(await ended(pending.id)).toEqual({
      status: "rejected",
      end_reason: "duplicate",
    });
    expect(await ended(failed.id)).toEqual({
      status: "cancelled",
      end_reason: "duplicate",
    });
    expect((await audits(pending.id))[0].detail).toContain(
      "原因：重複；和範例群組上週的需求相同",
    );
    expect((await audits(failed.id))[0].detail).toContain(
      "原因：重複；和範例群組上週的需求相同",
    );
  });
});
