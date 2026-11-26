import { expect, it } from "vitest";
import { checkFlowEvidence, disposeRetainedWorkspaces, formatFlowFailure, waitForWorkDisposal } from "../scripts/acceptance/flows/evidence.js";

const clean = { stranded: 0, stale: 0, leaks: 0, resources: [] as string[], states: ["answered"], audit: ["已回答"], events: ["驗證完成"], messages: ["共五張票"] };
const canary = "ExampleKey266";

it("只對已結案且工作副本名稱屬本次實例的任務要求回收", async () => {
  const instance = "verify-266-test";
  const id = "1b9fa83f-0e8e-479d-8b63-40a197186a19";
  const row = { id, workspace: `agentflow-${instance}-job-${id}`, completed_at: new Date() };
  const calls: string[] = [];
  await disposeRetainedWorkspaces(instance, [row, { ...row, completed_at: null }, { ...row, workspace: "不是本次工作副本" }], async run => { calls.push(run); });
  expect(calls).toEqual([id]);
  await expect(disposeRetainedWorkspaces("production", [row], async () => {})).rejects.toThrow("驗收");
});

it("群組收到通知但執行器仍在清理時等待，過期後保留真正的殘留", async () => {
  let reads = 0;
  expect(await waitForWorkDisposal(async () => ++reads === 1 ? ["工作卷"] : [], 500, 1)).toEqual([]);
  expect(reads).toBe(2);
  expect(await waitForWorkDisposal(async () => ["基底卷"], 0, 1)).toEqual(["基底卷"]);
});

it("資源未回收時列出種類與名稱，並遮蔽其中的虛構金鑰", () => {
  const detail = formatFlowFailure("結案", { ...clean, resources: [`資料卷 驗收卷${canary}`] }, [canary]);
  expect(detail).toContain("資料卷 驗收卷[已遮蔽]");
  expect(detail).not.toContain(canary);
});

it("四個結案條件任一不符都阻擋通過", () => {
  expect(checkFlowEvidence(clean, [canary])).toEqual([]);
  for (const change of [{ stranded: 1 }, { stale: 1 }, { resources: ["工作卷"] }, { leaks: 1 }, { messages: [`回答${canary}`] }]) {
    expect(checkFlowEvidence({ ...clean, ...change }, [canary])).toHaveLength(1);
  }
});

it("失敗摘要指出步驟並保留四種線索，不會因截短而露出虛構金鑰前綴", () => {
  const message = "群組已收到" + "票".repeat(65) + canary;
  const detail = formatFlowFailure("等待合併通知", { ...clean, messages: [message], events: [canary] }, [canary]);
  for (const expected of ["等待合併通知", "answered", "已回答", "群組已收到", "[已遮蔽]"]) expect(detail).toContain(expected);
  expect(detail).not.toContain("ExampleKey");
});
