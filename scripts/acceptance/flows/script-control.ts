import { once } from "node:events";
import type { ModelStep } from "./model-upstream.js";
import type { ModelFault } from "./model-service.js";

async function exchangeControl(packet: Record<string, unknown>) {
  if (!process.send || !process.connected || process.env.ACCEPTANCE_FLOW_REAL !== "0") throw new Error("僅固定劇本可設定驗收模型");
  const ack = once(process, "message", { signal: AbortSignal.timeout(packet.event === "restart" ? 90000 : 5000) });
  process.send(packet);
  const [message] = await ack;
  return message;
}

export async function installModelSteps(steps: readonly ModelStep[], exchange = (script: readonly ModelStep[]) => exchangeControl({ event: "script", steps: script })) {
  if ((await exchange(steps))?.event !== "script-ready") throw new Error("主控未確認新的模型劇本");
}

export async function installModelFault(steps: readonly ModelStep[], fault: ModelFault) {
  if ((await exchangeControl({ event: "script", steps, fault }))?.event !== "script-ready") throw new Error("未能設定模型故障");
}

export async function modelFaultHits(): Promise<number> {
  const ack = await exchangeControl({ event: "hits" });
  if (ack?.event !== "hits" || !Number.isInteger(ack.count) || ack.count < 0) throw new Error("無法讀取模型故障次數");
  return ack.count;
}

export async function restartOwnRunner(runId: string): Promise<{ instance: string; previousPid: number; pid: number }> {
  const ack = await exchangeControl({ event: "restart", runId });
  if (ack?.event !== "restarted") throw new Error("未確認本次執行器重啟");
  return ack.receipt;
}
