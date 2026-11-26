import { expect, it } from "vitest";
import { startModelService } from "../scripts/acceptance/flows/model-service.js";
import { modelAccount, modelToken } from "../scripts/acceptance/flows/subscription.js";

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
