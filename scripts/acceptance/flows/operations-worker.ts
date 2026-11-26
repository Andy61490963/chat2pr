import { z } from "zod";
import type Docker from "dockerode";
import { Containers, type ContainerDeadline } from "../../../server/containers.js";
import { instanceName } from "../../../server/config.js";

export function operationsInstance() {
  const instance = instanceName();
  if (
    !instance.startsWith("verify-266-") ||
    process.env.NODE_ENV === "production" ||
    process.env.ACCEPTANCE_FLOW_REAL !== "0"
  )
    throw new Error("維運控制項只能用於具名隔離實例的固定劇本");
  return instance;
}

export type WorkerFault = "install" | "create" | null;
export const installMarker = "lantern-install-fixture";
// 固定不存在的內容摘要。Docker 的 create 不拉映像，也不會碰同名的本機標籤。
export const missingImage = "sha256:" + "0".repeat(64);
const createCommand = "echo lantern-create-fixture >&2; exit 20";

export function operationsPhaseInput(fault: WorkerFault, path: string, body: unknown) {
  if (!fault || path !== "phase") return body;
  operationsInstance();
  const phase = z.looseObject({ phase: z.string(), runId: z.uuid() }).parse(body);
  if (phase.phase !== "install") return body;
  return {
    ...phase,
    command: fault === "install" ? "echo " + installMarker + " >&2; exit 19" : createCommand,
  };
}

/** 經過映像版本、工作卷、網路與資源限制檢查後，才讓本次建立請求收到真正的 Docker 404。 */
export function operationsCreateInput(options: Docker.ContainerCreateOptions): Docker.ContainerCreateOptions {
  const cmd = options.Entrypoint;
  if (
    !Array.isArray(cmd) ||
    cmd.length !== 3 ||
    cmd[0] !== "sh" ||
    cmd[1] !== "-c" ||
    cmd[2] !== createCommand
  )
    return options;
  if (
    options.Labels?.["io.agentflow.instance"] !== operationsInstance() ||
    options.Labels["io.agentflow.managed"] !== "true" ||
    !z.uuid().safeParse(options.Labels["io.agentflow.run"]).success
  )
    throw new Error("拒絕改動其他實例的容器建立請求");
  return { ...options, Image: missingImage };
}

export class OperationsContainers extends Containers {
  override createOwnedContainer(
    runId: string,
    options: Docker.ContainerCreateOptions,
    deadline: ContainerDeadline,
  ) {
    return super.createOwnedContainer(runId, operationsCreateInput(options), deadline);
  }
}
