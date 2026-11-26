import { fork } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectFlowCases } from "./catalog.js";
import { classifyFlowFailure } from "./known-failures.js";
import type { FlowStack } from "./stack.js";
import type { RecordInput } from "../ledger.js";
import type { startModelService } from "./model-service.js";

type Outcome = { passed: boolean; detail: string; references?: RecordInput["references"] };
type Model = Awaited<ReturnType<typeof startModelService>>;

async function drive(stack: FlowStack, number: number, fault: string | undefined, model: Model | undefined, canaries: string[], signal: AbortSignal) {
  const { lineQuerySteps, discordChangeSteps } = await import("./basic.js");
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = { ...stack.env, ADMIN_GITHUB_ID: "266001", ACCEPTANCE_FLOW_REAL: model ? "0" : "1" };
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "ComSpec", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ProgramFiles"]) if (process.env[key]) env[key] = process.env[key];
  const child = fork(fileURLToPath(new URL("./run-case.ts", import.meta.url)), [], { env, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let outcome: Outcome | undefined;
  const abort = () => child.kill();
  const timeout = setTimeout(abort, 12 * 60_000);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await new Promise<Outcome>((done, fail) => {
      child.on("message", (packet: { event: string; id?: string } & Partial<Outcome>) => {
        if (packet.event === "ready") child.send({ number, fault, canaries });
        if (packet.event === "project" && typeof packet.id === "string") {
          model?.script((number === 1 ? lineQuerySteps : discordChangeSteps)(packet.id));
          child.send({ event: "continue" });
        }
        if (packet.event === "result" && typeof packet.detail === "string") outcome = { passed: packet.passed === true, detail: packet.detail, references: packet.references };
      });
      child.once("error", fail);
      child.once("exit", code => {
        if (!outcome || code !== 0) fail(new Error(outcome?.detail || "案例程序逾時、中斷或未交回結果"));
        else if (outcome.passed && model && model.requests() === 0) fail(new Error("沒有請求抵達訂閱上游，不列為通過"));
        else done(outcome);
      });
    });
  } finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
}

async function main() {
  const { real, fault, cases } = selectFlowCases(process.argv.slice(2));
  const scratch = process.env.ACCEPTANCE_OUTPUT_ROOT;
  if (!scratch || resolve(scratch) !== scratch) throw new Error("請將 ACCEPTANCE_OUTPUT_ROOT 指向本次驗收的專屬暫存目錄（絕對路徑）");
  if (process.env.AGENTFLOW_INSTANCE === "production" || process.env.NODE_ENV === "production") throw new Error("不可由正式實例啟動流程驗收");
  if (real && !process.env.ACCEPTANCE_AUTH_SOURCE) throw new Error("真實模型必須明確提供 ACCEPTANCE_AUTH_SOURCE，由驗收啟動器建立受限副本");
  const suiteId = `266-${Date.now()}-${randomBytes(4).toString("hex")}`;
  // ledger 使用專案的遮蔽器。主控不載入工作目錄的預設設定或真實登入。
  process.env.SECRETS_FILE = join(scratch, suiteId, "no-config.json");
  await mkdir(scratch, { recursive: true });
  const { AcceptanceLedger } = await import("../ledger.js");
  const { startFlowStack } = await import("./stack.js");
  const { startModelService } = await import("./model-service.js");
  const { createGitHubProvider } = await import("./github-provider.js");
  const { redact: redactCredentials } = await import("../../../shared/credentials.js");
  const { fixture } = await createGitHubProvider();
  const ledger = await AcceptanceLedger.open(scratch, { version: 1, suiteId, repo: fixture.repo, baselineSha: fixture.baseSha, createdAt: new Date().toISOString(), cases: cases.map(item => ({ id: item.id, title: item.title, expected: [item.title, "四項結案不變式成立"], environment: "isolated", evidenceKind: real ? "real-model" : "deterministic", required: true })) });
  console.log(`驗收紀錄：${ledger.directory}`);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    for (const item of cases) {
      controller.signal.throwIfAborted();
      const row = { caseId: item.id, attempt: 1 };
      await ledger.append({ ...row, status: "started" });
      if (item.number > 2) {
        await ledger.append({ ...row, status: "blocked", detail: "尚未接上全流程劇本，不列為通過或已知失敗" });
        console.error(`${item.id} 尚未實作`); process.exitCode = 1; continue;
      }
      const start = performance.now();
      const keys = { githubAppId: "26601", githubClientId: "AcceptanceClient266", githubClientSecret: randomBytes(24).toString("hex"), githubWebhookSecret: randomBytes(24).toString("hex"), lineSecret: randomBytes(24).toString("hex"), lineToken: "AcceptanceLineToken266", discordToken: "AcceptanceDiscord266", discordApplicationId: "100000000000000003", githubPrivateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
      const canaries = [keys.githubClientSecret, keys.githubWebhookSecret, keys.lineSecret, keys.lineToken, keys.discordToken, keys.githubPrivateKey, "ExampleInstallation266", "AcceptanceModelToken266"];
      let model: Model | undefined, stack: FlowStack | undefined;
      let outcome: Outcome = { passed: false, detail: "無法啟動隔離服務" };
      try {
        if (!real) model = await startModelService(fault === "model");
        stack = await startFlowStack({ instance: `verify-${suiteId}-${item.number}`, real, scratch, extraSecrets: keys, modelOrigin: model?.origin });
        canaries.push(stack.runnerKey);
        outcome = await drive(stack, item.number, fault, model, canaries, controller.signal);
      } catch (error) {
        outcome = { passed: false, detail: error instanceof Error ? error.message : "流程中斷" };
      } finally {
        try { await stack?.close(); } catch { outcome.passed = false; outcome.detail += "；本次工作資源未確認清除"; }
        try { await model?.close(); } catch { outcome.passed = false; outcome.detail += "；模型服務未確認關閉"; }
      }
      const detail = redactCredentials(canaries.reduce((text, key) => text.replaceAll(key, "[已遮蔽]"), outcome.detail));
      const elapsed = Math.round((performance.now() - start) / 1000);
      const known = !outcome.passed && !fault && !real ? classifyFlowFailure(item.number, detail) : undefined;
      const verdict = outcome.passed ? "通過" : known ? `已知失敗（#${known}）` : "失敗";
      await ledger.append({ ...row, status: outcome.passed ? "passed" : "failed", references: outcome.references, detail: `${verdict}；${elapsed} 秒；${detail}` });
      console.log(`${item.id} ${verdict}（${elapsed} 秒）\n${detail}`);
      if (!outcome.passed && !known) process.exitCode = 1;
    }
  } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : "驗收主控失敗"); process.exitCode = 1; });
