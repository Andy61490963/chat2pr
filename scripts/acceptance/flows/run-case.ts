import { once } from "node:events";
import { Database } from "../../../server/db.js";
import { Containers } from "../../../server/containers.js";
import { startFlowApplication } from "./application.js";
import { runLineQuery, runDiscordChange } from "./basic.js";
import { conversationFlows, type ConversationNumber } from "./conversations.js";
import { installModelSteps, installModelFault, modelFaultHits, restartOwnRunner } from "./script-control.js";
import { recoverySetupStep, runRecoveryFlow, type RecoveryNumber } from "./recovery.js";
import { runOperationsFlow } from "./operations.js";
import { startChatProvider } from "./chat-provider.js";
import { createGitHubProvider } from "./github-provider.js";
import { checkFlowEvidence, disposeRetainedWorkspaces, formatFlowFailure, queueDiagnosis, readFlowEvidence, settleFlowEvidence, waitForWorkDisposal, type RetainedRun } from "./evidence.js";

async function resources(instance: string) {
  const docker = new Containers(instance).docker;
  const filters = { label: [`io.agentflow.instance=${instance}`] };
  const [containers, networks, volumes] = await Promise.all([docker.listContainers({ all: true, filters }), docker.listNetworks({ filters }), docker.listVolumes({ filters })]);
  return new Set([...containers.map(row => `容器 ${row.Id}`), ...networks.map(row => `網路 ${row.Id}`), ...(volumes.Volumes ?? []).map(row => `資料卷 ${row.Name}`)]);
}

async function main() {
  if (!process.send || !process.env.AGENTFLOW_INSTANCE?.startsWith("verify-266-")) throw new Error("案例必須由隔離驗收主控啟動");
  const instance = process.env.AGENTFLOW_INSTANCE;
  const initial = once(process, "message");
  process.send({ event: "ready" });
  const [input] = await initial as [{ number: number; fault?: string; canaries: string[] }];
  let step = "建立聊天與儲存庫替身";
  const baseline = await resources(instance);
  const chat = await startChatProvider();
  let app: Awaited<ReturnType<typeof startFlowApplication>> | undefined;
  const db = new Database(process.env.DATABASE_URL!);
  const capture = async () => {
    const outstanding = async () => [...await resources(instance)].filter(id => !baseline.has(id));
    return readFlowEvidence(db, chat.records.map(row => row.text), await outstanding(), input.canaries);
  };
  const dispose = async (runs: RetainedRun[]) => {
    const { HttpRunner } = await import("../../../server/execution.js");
    const runner = new HttpRunner();
    await disposeRetainedWorkspaces(instance, runs, async runId => { await runner.call("dispose", { runId }, 20000); });
  };
  const retainedRuns = () => db.query<RetainedRun>("SELECT id,workspace,completed_at FROM runs WHERE workspace IS NOT NULL");
  const diagnose = async (packet: { event?: string }) => {
    if (packet?.event !== "diagnose") return;
    const evidence = await capture();
    const queue = evidence.stranded && app ? queueDiagnosis(await app.ctx.admin("GET", "/api/capacity").catch(() => null)) : "";
    const detail = [formatFlowFailure(`${step}：整案超時`, evidence, input.canaries), queue].filter(Boolean).join("\n");
    if (process.connected) process.send?.({ event: "diagnosis", detail });
  };
  const onMessage = (packet: { event?: string }) => { void diagnose(packet).catch(() => {}); };
  process.on("message", onMessage);
  try {
    const github = await createGitHubProvider({ omitPullRequest: input.fault === "pr" });
    step = "登入、啟用專案及驗證基底";
    if (input.number === 10) await installModelSteps([recoverySetupStep]);
    app = await startFlowApplication({ chat, github, workerImage: "line-agentflow-worker:local", autoSetup: input.number === 10, setModelSteps: installModelSteps, restartRunner: restartOwnRunner });
    const { ctx } = app;
    const ack = once(process, "message");
    process.send({ event: "project", id: ctx.projectId });
    await ack;
    const poll = ctx.poll;
    ctx.poll = (label, probe) => { step = label; process.send?.({ event: "step", detail: label }); return poll(label, probe); };
    step = `投遞情境 ${input.number} 的來源事件`;
    const result = input.number === 1 ? await runLineQuery(ctx) : input.number === 2 ? await runDiscordChange(ctx) :
      input.number <= 9 ? await conversationFlows[input.number as ConversationNumber]({ ...ctx, setModelSteps: installModelSteps }) :
      input.number <= 14 ? await runRecoveryFlow(input.number as RecoveryNumber, { ...ctx, setModelSteps: installModelSteps, setModelFault: installModelFault, modelFaultHits, commitFixture: github.commitFixture, mergeFixturePr: github.mergeFixturePr }) :
      await runOperationsFlow(input.number, ctx, app.operations);
    step = "核對結案不變式";
    const runs = await retainedRuns();
    const retained = new Set<string>();
    await disposeRetainedWorkspaces(instance, runs, async (_id, workspace) => {
      for (const suffix of ["", "-baseline", "-env"]) retained.add(`資料卷 ${workspace}${suffix}`);
    });
    const orphans = await waitForWorkDisposal(async () => [...await resources(instance)].filter(item => !baseline.has(item) && !retained.has(item)));
    if (orphans.length) throw new Error("結案後仍有未登記的工作資源");
    await dispose(runs);
    const evidence = await settleFlowEvidence(capture);
    if (checkFlowEvidence(evidence, input.canaries).length) throw new Error("結案不變式未通過");
    const { groupMessages, ...references } = result;
    return { passed: true, references, detail: formatFlowFailure("完成", { ...evidence, messages: groupMessages }, input.canaries) };
  } catch (error) {
    let label = `${step}：${error instanceof Error ? error.message : "未知錯誤"}`;
    if (step !== "核對結案不變式") {
      try { await dispose(await retainedRuns()); } catch { label += "；本次工作副本未確認清除"; }
    }
    const evidence = await settleFlowEvidence(capture).catch(() => ({ stranded: 0, stale: 0, leaks: 0, resources: [], states: ["無法讀取診斷"], audit: [], events: [], messages: chat.records.map(record => record.text) }));
    const queue = evidence.stranded && app ? queueDiagnosis(await app.ctx.admin("GET", "/api/capacity").catch(() => null)) : "";
    return { passed: false, detail: [formatFlowFailure(label, evidence, input.canaries), queue].filter(Boolean).join("\n") };
  } finally {
    process.off("message", onMessage);
    try { await app?.close(); } finally { try { await chat.close(); } finally { await db.close(); } }
  }
}

try { process.send?.({ event: "result", ...await main() }); }
catch { process.send?.({ event: "result", passed: false, detail: "案例程序無法啟動或關閉；請核對工作資源" }); process.exitCode = 1; }
finally { process.disconnect?.(); }
