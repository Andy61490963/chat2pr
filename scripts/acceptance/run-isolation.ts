import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { AcceptanceLedger, type Manifest } from "./ledger.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(
  process.env.ACCEPTANCE_OUTPUT_ROOT ??
    resolve(root, "../../outputs/全流程驗收"),
);
const boundaries = process.argv.includes("--boundaries");
const limits = process.argv.includes("--limits");
const suiteId =
  process.env.ACCEPTANCE_SUITE_ID ??
  (limits
    ? "limits-races-20261106"
    : boundaries
      ? "boundaries-20261106"
      : "isolation-20261106");
if (boundaries || limits) {
  const url = new URL(
    process.env.TEST_DATABASE_URL ?? "http://missing.invalid",
  );
  if (url.port !== "15439" || !url.pathname.endsWith("_test"))
    throw new Error("故障驗收必須明確指定15439的獨立 *_test 資料庫");
}
const specs = limits
  ? [
      [
        "E02.index",
        "完整索引與超限標記",
        "5001真tar段落明示total/truncated；limited不發布半成品、不重複推論，新SHA恢復完整；分類器為替身",
      ],
      [
        "E02.context",
        "近期訊息與任務截斷",
        "301訊息／201任務真PG測試，分類輸入與audit揭露截斷；分類器為替身",
      ],
      [
        "E04.races",
        "核准、改版、取消與撤回競態",
        "20個同版核准只成功1個；amend/cancel與unsend/approve以真PG交易競爭，舊核准失效",
      ],
    ]
  : boundaries
    ? [
        [
          "E01.ingest",
          "大量、重送與亂序訊息",
          "真實簽章/Fastify/PG，1000筆分批亂序重送不重複，撤回不復活；不是LINE實際發送",
        ],
        [
          "E01.invalid",
          "非法訊息界線",
          "單批101、錯誤簽章、無效型別及4MB本文拒絕入庫",
        ],
        [
          "E03.notification",
          "通知接受後中斷",
          "LINE供應商替身已接受、真DB更新失敗後重試沿用同retry-key，409 accepted不重送",
        ],
        [
          "E06.statuses",
          "供應商HTTP錯誤",
          "AI代理、LINE圖片、GitHub封存下載的401403429500503替身不回顯憑證，不內部無限重試",
        ],
        [
          "E06.notifications",
          "通知有界重試",
          "LINE401403429500503替身每種最多3次，顯示原因並停止",
        ],
        [
          "E06.timeout",
          "模型逾時",
          "上游替身遵守abort，真代理以500ms工作deadline中止，不重送",
        ],
        [
          "E06.stream",
          "串流中斷",
          "真HTTP/Fastify+上游ReadableStream替身，客戶端結束且保守記帳一次",
        ],
        [
          "E08.budget",
          "預留額度競爭與繼續收訊",
          "真PG50個並行預留最多15美元；辨識零呼叫且仍可保存新訊息",
        ],
        [
          "E12.authorization",
          "管理者與跨群邊界",
          "有效session非白名單者不可讀寫；跨群分頁游標不能取內容",
        ],
      ]
    : [
        [
          "E07.timeout",
          "工作逾時與回收",
          "真實 phase 超過 1 秒限制，容器與工作卷均被回收",
        ],
        [
          "E07.oom",
          "記憶體限制",
          "獨立 64 MiB 容器確實 OOMKilled／137；不代表正式 2 GiB 端到端恢復已測",
        ],
        ["E07.pids", "程序數限制", "獨立 16 PID 上限回傳 EAGAIN 並清除容器"],
        [
          "E07.disk",
          "有限空間",
          "只填滿獨立 8 MiB tmpfs，出現 ENOSPC 後清理，不填主機磁碟",
        ],
        [
          "E09.versions",
          "冷快取、命中與新舊版本",
          "真 Git daemon + Docker 兩個 instance，相同 run ID 仍隔離；同／新／舊 SHA 的內容與樹一致並記錄耗時",
        ],
        ["E09.corrupt", "損壞的快照", "損壞 README 後重建快照，不能命中壞內容"],
        [
          "E10.permission",
          "已有快取時撤銷權限",
          "真實本機快取 + GitHub 403 替身；逐次權限檢查阻擋取憑證。未撤銷正式 GitHub App",
        ],
        [
          "E11.config",
          "名稱與啟動設定",
          "純函式驗證拒絕錯誤名稱及非專用的機密、Codex 目錄、埠",
        ],
        [
          "E11.cleanup",
          "取消與啟動清理隔離",
          "真 Docker A/B 相同 run ID 及 legacy 哨兵；cleanup/cancel/dispose 保持其他環境 heartbeat/卷",
        ],
      ];
const path = join(output, `verify-${suiteId}`, "manifest.json");
const manifest: Manifest = existsSync(path)
  ? JSON.parse(readFileSync(path, "utf8"))
  : {
      version: 1,
      suiteId,
      repo: process.env.ACCEPTANCE_REPO ?? "example-org/test",
      baselineSha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      createdAt: new Date().toISOString(),
      cases: specs.map(([id, title, expected]) => ({
        id,
        title,
        environment: "isolated",
        evidenceKind: "deterministic",
        expected: [expected],
        required: true,
      })),
    };
const ledger = await AcceptanceLedger.open(output, manifest),
  summary = await ledger.summary();
const retry = process.argv.includes("--retry");
if (summary.some((s) => s.resume === "reconcile-required"))
  throw new Error("前次執行中斷，必須先核對 ledger；禁止盲目重跑");
if (summary.some((s) => s.attempts > 0) && !retry)
  throw new Error("套件已執行過，修正後請明確加 --retry 保留首輪結果");
const attempts = new Map(summary.map((s) => [s.id, s.attempts + 1]));
for (const spec of manifest.cases)
  await ledger.append({
    caseId: spec.id,
    attempt: attempts.get(spec.id)!,
    status: "started",
  });
const attemptLabel = Math.max(...attempts.values());
const artifactDir = join(ledger.directory, `attempt-${attemptLabel}`);
mkdirSync(artifactDir, { recursive: true });
const resultPath = join(ledger.directory, `vitest-${attemptLabel}.json`);
const files = limits
  ? [
      "tests/repo-index.test.ts",
      "tests/image-context.test.ts",
      "tests/acceptance-races.test.ts",
    ]
  : boundaries
    ? ["tests/acceptance-boundaries.test.ts"]
    : [
        "tests/instance-isolation.test.ts",
        "tests/acceptance-resources.test.ts",
        "tests/acceptance-cache.test.ts",
      ];
const result = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    ...files,
    "--reporter=json",
    `--outputFile=${resultPath}`,
  ],
  {
    cwd: root,
    env: { ...process.env, ACCEPTANCE_ARTIFACT_DIR: artifactDir },
    encoding: "utf8",
    timeout: 600000,
    windowsHide: true,
    maxBuffer: 5 * 1024 * 1024,
  },
);
const logPath = join(ledger.directory, `vitest-${attemptLabel}.log`);
writeFileSync(logPath, (result.stdout ?? "") + (result.stderr ?? ""));
const report = existsSync(resultPath)
  ? JSON.parse(readFileSync(resultPath, "utf8"))
  : null;
const tests =
  report?.testResults?.flatMap(
    (file: { assertionResults: unknown[] }) => file.assertionResults,
  ) ?? [];
const artifactPath = report ? resultPath : logPath;
const artifacts = [
  {
    path: artifactPath,
    sha256: createHash("sha256")
      .update(readFileSync(artifactPath))
      .digest("hex"),
  },
];
for (const spec of manifest.cases) {
  const selected = tests.filter((test: { fullName: string }) =>
    spec.id === "E02.index"
      ? test.fullName.startsWith("E02：")
      : spec.id === "E02.context"
        ? test.fullName.includes("近期訊息與任務超過上限")
        : spec.id === "E11.config"
          ? test.fullName.includes("執行環境命名與啟動限制")
          : spec.id === "E11.cleanup"
            ? test.fullName.includes("真實 Docker：相同 run ID")
            : test.fullName.startsWith(spec.id + "："),
  );
  const status =
    selected.length === 0
      ? "blocked"
      : selected.every((test: { status: string }) => test.status === "passed")
        ? "passed"
        : "failed";
  const evidence = [...artifacts];
  const timingPath = join(artifactDir, "cache-timings.json");
  if (spec.id === "E09.versions" && existsSync(timingPath))
    evidence.push({
      path: timingPath,
      sha256: createHash("sha256")
        .update(readFileSync(timingPath))
        .digest("hex"),
    });
  await ledger.append({
    caseId: spec.id,
    attempt: attempts.get(spec.id)!,
    status,
    artifacts: evidence,
    detail: selected.length
      ? selected
          .map(
            (test: {
              fullName: string;
              status: string;
              failureMessages: string[];
              duration: number;
            }) =>
              `${test.fullName}：${test.status}，${test.duration} ms\n${(test.failureMessages ?? []).join("\n")}`,
          )
          .join("\n")
          .slice(0, 10000)
      : "測試程序未產生此案例結果，未視為通過",
  });
}
writeFileSync(
  join(ledger.directory, "summary.json"),
  JSON.stringify(await ledger.summary(), null, 2),
);
console.log(
  JSON.stringify({
    suiteId,
    exitCode: result.status,
    summary: join(ledger.directory, "summary.json"),
    firstFailuresPreserved: true,
  }),
);
process.exitCode = result.status ?? 1;
