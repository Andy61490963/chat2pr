import { expect, it } from "vitest";
import { startModelService } from "../scripts/acceptance/flows/model-service.js";
import { modelAccount, modelToken } from "../scripts/acceptance/flows/subscription.js";

it("背景推論檢查不會吃掉下一個需求的判讀結果或觸發故障", async () => {
  const model = await startModelService(false);
  const send = (body: object) => fetch(model.origin + "/backend-api/codex/responses", { method: "POST", headers: { authorization: `Bearer ${modelToken}`, "chatgpt-account-id": modelAccount }, body: JSON.stringify(body) });
  try {
    model.script([{ kind: "text", text: "劇本專屬結果" }], { kind: "error", status: 502 });
    const probe = { instructions: "只輸出數字 1。", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "1" }] }] };
    expect(await (await send(probe)).text()).not.toContain("劇本專屬結果");
    expect(await (await send({})).text()).toContain("劇本專屬結果");
    expect((await send(probe)).status).toBe(200);
    expect(model.faultHits()).toBe(0);
    expect((await send({})).status).toBe(502);
  } finally { await model.close(); }
});

it("僅在合法模型請求抵達故障階段才耗盡額度，重新裝入劇本會恢復", async () => {
  const model = await startModelService(false);
  const headers = { authorization: `Bearer ${modelToken}`, "chatgpt-account-id": modelAccount };
  const request = (valid = true) => fetch(model.origin + "/backend-api/codex/responses", { method: "POST", headers: valid ? headers : {} });
  const allowed = async () => (await (await fetch(model.origin + "/account")).json()).allowed;
  try {
    model.script([{ kind: "text", text: "完成" }], { kind: "error", status: 429 });
    expect((await request(false)).status).toBe(401);
    expect((await request()).status).toBe(200);
    expect(await allowed()).toBe(true);
    expect(model.faultHits()).toBe(0);
    expect((await request()).status).toBe(429);
    expect((await request()).status).toBe(429);
    expect(model.faultHits()).toBe(2);
    expect(await allowed()).toBe(false);
    model.script([]);
    expect(await allowed()).toBe(true);
    expect(model.faultHits()).toBe(0);
  } finally { await model.close(); }
});
