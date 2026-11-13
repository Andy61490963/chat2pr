import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** 訂閱與 API 都只接收有限能力；主憑證不得出現在工作輸入或容器。 */
export function providerOptions(job, shellEnv, toolEnv = shellEnv) {
  if (Object.hasOwn(job, "auth")) throw new Error("工作不得攜帶主訂閱憑證");
  if (!job.token || !job.proxyUrl) throw new Error("工作缺少有限推論授權");
  return {
    apiKey: job.token,
    env: {
      ...shellEnv,
      CODEX_HOME: join(shellEnv.HOME ?? "/tmp/home", ".codex"),
    },
    config: {
      model_provider: "agentflow",
      model_providers: {
        agentflow: {
          name: "AgentFlow",
          base_url: job.proxyUrl,
          env_key: "CODEX_API_KEY",
          wire_api: "responses",
          requires_openai_auth: false,
          supports_websockets: false,
          request_max_retries: 0,
          stream_max_retries: 0,
          stream_idle_timeout_ms: Math.max(
            1000,
            Math.min(Number(job.timeoutMs) || 1800000, 1800000),
          ),
        },
      },
      shell_environment_policy: { inherit: "none", set: toolEnv },
    },
  };
}

/** CLI 要求 CODEX_HOME 已存在；只建立空目錄，不建立任何登入檔。 */
export async function prepareProviderOptions(job, shellEnv, toolEnv) {
  const options = providerOptions(job, shellEnv, toolEnv);
  await mkdir(options.env.CODEX_HOME, { recursive: true, mode: 0o700 });
  return options;
}
