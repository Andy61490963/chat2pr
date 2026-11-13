import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { GitHub } from "../server/github.ts";
import { Containers } from "../server/containers.ts";
import { SourceCache, sourceVolume } from "../server/source-cache.ts";

// 只讀取指定 commit，不推送、建 PR、呼叫 AI 或通知 LINE。
async function main() {
  const [repo, base, next, output] = process.argv.slice(2);
  if (
    !repo ||
    !/^[a-f0-9]{40}$/.test(base ?? "") ||
    !/^[a-f0-9]{40}$/.test(next ?? "") ||
    !output
  )
    throw new Error(
      "用法：node --import tsx scripts/benchmark-source.mjs 擁有者/儲存庫 基底SHA 新版SHA 輸出JSON路徑",
    );
  const github = new GitHub(),
    containers = new Containers(),
    cache = new SourceCache(containers);
  const image =
    process.env.SOURCE_BENCHMARK_WORKER ?? "line-agentflow-worker:local";
  const results = [];
  for (const [name, sha] of [
    ["基底版本", base],
    ["基底版本再次使用", base],
    ["新版", next],
    ["新版再次使用", next],
  ]) {
    const runId = randomUUID(),
      started = Date.now();
    console.log(JSON.stringify({ name, runId, state: "開始" }));
    try {
      const source = await github.sourceAccess({ repo }, sha);
      const report = await cache.prepare(runId, image, source);
      const wallMs = Date.now() - started;
      const checked = await containers.phase(runId, image, [
        "node",
        "/opt/agentflow/collect.mjs",
      ]);
      if (checked.exitCode !== 0 || JSON.parse(checked.stdout).files.length)
        throw new Error("未修改的工作副本產生差異，驗收失敗");
      const tree = await containers.phase(runId, image, [
        "git",
        "rev-parse",
        "HEAD^{tree}",
      ]);
      if (tree.exitCode !== 0) throw new Error("無法讀取副本檔案樹");
      results.push({
        name,
        runId,
        wallMs,
        ...report,
        tree: tree.stdout.trim(),
        clean: true,
        cacheVolume: sourceVolume(source),
      });
      console.log(JSON.stringify(results.at(-1)));
      writeFileSync(
        output,
        JSON.stringify(
          { at: new Date().toISOString(), repo, results },
          null,
          2,
        ),
      );
    } finally {
      await containers.dispose(runId);
    }
  }
}
main().catch((error) => {
  // SDK 錯誤物件可能含請求授權標頭，不序列化整個錯誤。
  console.error(error.message);
  process.exitCode = 1;
});
