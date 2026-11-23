export type StartupTaskCheck = { usable: boolean; detail: string };
export function startupTaskCheck(state: string | undefined): StartupTaskCheck;

export type HostStartRoute =
  { route: "task" } | { route: "direct"; reason: string };
export function hostStartRoute(input: {
  taskState: string | undefined;
  started?: boolean;
  appeared?: boolean;
}): HostStartRoute;

/** 跟作業系統互動的薄層；測試注入假實作。 */
export type HostStartIo = {
  taskState(): string | undefined;
  startTask(): boolean;
  startDirect(): void;
  supervisorRunning(): boolean;
  wait(ms: number): Promise<void>;
};
export function bringHostBack(
  io: HostStartIo,
  options?: { seconds?: number },
): Promise<HostStartRoute & { running: boolean }>;

export function hostStateAdvice(state: {
  supervisor: boolean;
  runner: boolean;
  app: boolean;
  taskState: string | undefined;
}): string[];
