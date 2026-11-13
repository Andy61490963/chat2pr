import { afterAll, beforeEach, expect, it } from "vitest";
import { db, reset, fixture } from "./helpers.js";
import { Triage } from "../server/triage.js";
import { GitHub } from "../server/github.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";

beforeEach(reset);
afterAll(() => db.close());

async function scenario(change: () => Promise<unknown>) {
  const project = await fixture();
  const line = new Line(db);
  await line.ingest({ events: [{ webhookEventId: "settings-message", type: "message", source: { type: "group", groupId: "group-a" }, message: { id: "settings-source", type: "text", text: "請新增綠色按鈕" } }] });
  const github = new GitHub();
  github.context = async () => ({
    branches: {names:["main"],defaultBranch:"main",truncated:false}, branchError: null, sha: "test-base", paths: [], files: {}, truncated: false });
  return new Triage(db, { classify: async () => {
    await change();
    return [{ kind: "request", projectId: project, title: "新增綠色按鈕", summary: "請新增綠色按鈕", acceptance: ["畫面顯示綠色按鈕"], sourceIds: ["settings-source"], contextSourceIds: [], risks: [], missing: [], relatedTaskId: null, suggestions: [] }];
  } }, github, line, new Budget(db));
}

it("判讀尚未完成時全域暫停，晚到結果不能核准或處理掉來源", async () => {
  const triage = await scenario(() => db.query("UPDATE settings SET value=jsonb_set(value,'{paused}','true')"));
  await expect(triage.process("group-a")).rejects.toThrow("工作流程設定已改變");
  expect(await db.query("SELECT * FROM tasks")).toHaveLength(0);
  expect(await db.one("SELECT processed FROM messages WHERE id='settings-source'")).toEqual({ processed: false });
});

it("判讀途中暫停又恢復，仍以 revision 拒絕舊結果", async () => {
  const triage = await scenario(async () => {
    await db.query("UPDATE settings SET value=jsonb_set(value,'{paused}','true')");
    await db.query("UPDATE settings SET value=jsonb_set(value,'{paused}','false')");
  });
  const original = await db.one<{ revision: string }>("SELECT revision FROM settings");
  await expect(triage.process("group-a")).rejects.toThrow("工作流程設定已改變");
  expect((await db.settings()).paused).toBe(false);
  expect((await db.one<{ revision: string }>("SELECT revision FROM settings")).revision).not.toBe(original.revision);
  expect(await db.query("SELECT * FROM tasks")).toHaveLength(0);
  expect(await db.one("SELECT processed FROM messages WHERE id='settings-source'")).toEqual({ processed: false });
});

it("設定內容沒有變動時不換 revision，正常結果仍能建立待確認任務", async () => {
  const triage = await scenario(() => db.query("UPDATE settings SET value=value"));
  const original = await db.one<{ revision: string }>("SELECT revision FROM settings");
  await triage.process("group-a");
  expect((await db.one<{ revision: string }>("SELECT revision FROM settings")).revision).toBe(original.revision);
  expect(await db.one("SELECT status,approved_version FROM tasks")).toEqual({ status: "awaiting_approval", approved_version: null });
  expect(await db.one("SELECT processed FROM messages WHERE id='settings-source'")).toEqual({ processed: true });
});
