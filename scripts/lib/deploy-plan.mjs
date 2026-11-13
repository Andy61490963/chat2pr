// 監督程序、通道程序與它們讀取的設定：有變更時要重啟全部主機程序才會生效。
const hostFiles = [
  "scripts/start-windows.mjs",
  "scripts/tunnel.ts",
  "scripts/lib/public-health.mjs",
  "server/tunnel-provider.ts",
  "server/config.ts",
];

/**
 * 依這次更新改到的檔案決定部署要做哪些事。
 * 執行器一律重啟（只重建 app 不會更新它）；相依套件或主機程序有變更時重啟全部主機程序。
 */
export function deployPlan(changed, { restartHost = false } = {}) {
  const has = (test) => changed.some(test);
  const install = has(
    (file) => file === "package.json" || file === "package-lock.json",
  );
  return {
    install,
    host:
      restartHost || install || has((file) => hostFiles.includes(file))
        ? "all"
        : "runner",
    workerChanged: has((file) => file.startsWith("worker/")),
  };
}
