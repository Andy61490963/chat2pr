/** 先核對所有驗收入口，通過後才能複製登入或啟動服務。 */
export function acceptanceSetupConfig(env: NodeJS.ProcessEnv) {
  const runner = Number(env.RUNNER_LISTEN_PORT ?? 14312);
  const broker = Number(
    env.SUBSCRIPTION_BROKER_PORT ??
      env.ACCEPTANCE_SUBSCRIPTION_BROKER_PORT ??
      runner + 1,
  );
  if (
    env.SUBSCRIPTION_BROKER_PORT !== undefined &&
    env.ACCEPTANCE_SUBSCRIPTION_BROKER_PORT !== undefined &&
    Number(env.SUBSCRIPTION_BROKER_PORT) !==
      Number(env.ACCEPTANCE_SUBSCRIPTION_BROKER_PORT)
  )
    throw new Error("驗收訂閱轉送與可信代理的埠必須一致");
  const ports = {
    runner,
    broker,
    app: Number(env.ACCEPTANCE_APP_PORT ?? 14310),
    db: Number(env.ACCEPTANCE_DB_PORT ?? 15440),
    model: Number(env.ACCEPTANCE_MODEL_PORT ?? 18080),
  };
  if (
    new Set(Object.values(ports)).size !== 5 ||
    Object.values(ports).some(
      (p) =>
        !Number.isInteger(p) ||
        p < 1024 ||
        p > 65535 ||
        [4310, 4311, 4312, 4313, 5439].includes(p),
    )
  )
    throw new Error("驗收必須使用互不重複且非正式的埠");
  const relayImage = env.ACCEPTANCE_SUBSCRIPTION_RELAY_IMAGE;
  if (!relayImage || relayImage.startsWith("-") || /\s/.test(relayImage))
    throw new Error("請指定已建立的 ACCEPTANCE_SUBSCRIPTION_RELAY_IMAGE");
  return { ports, relayImage };
}

/** Compose 使用不可變映像 ID，避免檢查後標籤被換成另一份映像。 */
export function pinSubscriptionRelay(inspected: unknown): string {
  const images = inspected as Array<{
    Id?: string;
    Config?: { Labels?: Record<string, string> };
  }>;
  if (
    !Array.isArray(images) ||
    images.length !== 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(images[0]?.Id ?? "") ||
    images[0]?.Config?.Labels?.["io.agentflow.subscription-relay"] !== "v1"
  )
    throw new Error("訂閱轉送映像缺少有效 ID 或專用版本標記");
  return images[0].Id!;
}

/** 只有確定未監聽才啟動新程序；舊協定、逾時或未知回應不能觸發清理。 */
export async function acceptanceRunnerReady(
  url: string,
  key: string,
  instance: string,
  timeoutMs = 1000,
) {
  let response: Response;
  try {
    response = await fetch(`${url}/health`, {
      headers: { "x-runner-key": key },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED")
      return false;
    throw new Error("該埠執行器無法確認健康狀態，未啟動新程序");
  }
  if (!response.ok) throw new Error("該埠已有不同執行器或憑證不符");
  let health: { ok?: boolean; instance?: string; subscriptionBroker?: string };
  try {
    health = await response.json();
  } catch {
    throw new Error("該埠執行器健康回應無效，未啟動新程序");
  }
  if (!health || health.ok !== true || health.instance !== instance)
    throw new Error("該埠不是本套件的健康執行器");
  if (health.subscriptionBroker !== "v1")
    throw new Error(
      "該埠執行器不支援訂閱代理 v1，請核對後重啟；未自動停止既有程序",
    );
  return true;
}
