/** 依這次更新改到的檔案決定部署要做哪些事。 */
export function deployPlan(
  changed: string[],
  options?: { restartHost?: boolean },
): { install: boolean; host: "runner" | "all"; workerChanged: boolean };
