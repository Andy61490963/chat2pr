import { once } from "node:events";
import { Database } from "../../../server/db.js";
import { Containers } from "../../../server/containers.js";
import { startFlowApplication } from "./application.js";
import { runLineQuery, runDiscordChange } from "./basic.js";
import { startChatProvider } from "./chat-provider.js";
import { createGitHubProvider } from "./github-provider.js";
import { checkFlowEvidence, formatFlowFailure, readFlowEvidence } from "./evidence.js";

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
    const current = await resources(instance);
    return readFlowEvidence(db, chat.records.map(row => row.text), [...current].filter(id => !baseline.has(id)), input.canaries);
  };
  try {
    const github = await createGitHubProvider({ omitPullRequest: input.fault === "pr" });
    step = "登入、啟用專案及驗證基底";
    app = await startFlowApplication({ chat, github, workerImage: "line-agentflow-worker:local" });
    const { ctx } = app;
    const ack = once(process, "message");
    process.send({ event: "project", id: ctx.projectId });
    await ack;
    const poll = ctx.poll;
    ctx.poll = (label, probe) => { step = label; return poll(label, probe); };
    step = input.number === 1 ? "投遞 LINE 查詢" : "投遞 Discord 修改需求";
    const result = input.number === 1 ? await runLineQuery(ctx) : await runDiscordChange(ctx);
    step = "核對結案不變式";
    const evidence = await capture();
    if (checkFlowEvidence(evidence, input.canaries).length) throw new Error("結案不變式未通過");
    const { groupMessages, ...references } = result;
    return { passed: true, references, detail: formatFlowFailure("完成", { ...evidence, messages: groupMessages }, input.canaries) };
  } catch (error) {
    const label = `${step}：${error instanceof Error ? error.message : "未知錯誤"}`;
    const evidence = await capture().catch(() => ({ stranded: 0, stale: 0, leaks: 0, resources: [], states: ["無法讀取診斷"], audit: [], events: [], messages: chat.records.map(record => record.text) }));
    return { passed: false, detail: formatFlowFailure(label, evidence, input.canaries) };
  } finally {
    try { await app?.close(); } finally { try { await chat.close(); } finally { await db.close(); } }
  }
}

try { process.send?.({ event: "result", ...await main() }); }
catch { process.send?.({ event: "result", passed: false, detail: "案例程序無法啟動或關閉；請核對工作資源" }); process.exitCode = 1; }
finally { process.disconnect?.(); }
