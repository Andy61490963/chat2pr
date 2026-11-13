import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

// 只整理已存在的證據；不執行測試、不把單元測試換算成真實 LINE 通過。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(root, "../../outputs/全流程驗收");
const regressionPath = resolve(
  process.env.ACCEPTANCE_REGRESSION_REPORT ??
    resolve(output, "第三次自動化回歸.json"),
);
const regression = JSON.parse(readFileSync(regressionPath, "utf8"));
const tests = regression.testResults.flatMap(
  (file: { name: string; assertionResults: Record<string, unknown>[] }) =>
    file.assertionResults.map((test) => ({
      ...test,
      file: basename(file.name),
    })),
);
const modelPath = resolve(
  process.env.ACCEPTANCE_MODEL_REPORT ??
    resolve(output, "真實模型分類首輪.json"),
);
const model = JSON.parse(readFileSync(modelPath, "utf8"));
const suites = [
  "verify-isolation-20261106",
  "verify-boundaries-20261106",
  "verify-limits-races-20261106",
].flatMap((suite) =>
  JSON.parse(readFileSync(resolve(output, suite, "summary.json"), "utf8")).map(
    (row: Record<string, unknown>) => ({ ...row, suite }),
  ),
);
const definitions = [
  ...readFileSync(
    resolve(root, "docs/specs/full-flow-acceptance.md"),
    "utf8",
  ).matchAll(/^\| ([A-E]\d{2}) \| (.+) \|$/gm),
];
const notes: Record<
  string,
  {
    files: string[];
    names?: string;
    missing: string[];
    passed?: boolean;
    note?: string;
  }
> = {
  A01: {
    files: ["triage.test.ts", "execution.test.ts"],
    names: "明確低風險|只發布通過",
    missing: [
      "真實 LINE → Issue → PR → 通知的完整鏈路尚未開始",
      "無多餘人工審核的同一次實際任務證據",
    ],
  },
  A02: {
    files: ["chat.test.ts", "image-context.test.ts"],
    names: "一般聊天|自動辨識的閒聊|單純貼圖",
    missing: [],
    passed: true,
    note: "真實分類模型三輪皆不派工；LINE輸入仍為隔離重播。",
  },
  A03: {
    files: ["triage.test.ts", "routing.test.ts"],
    names: "缺少驗收|沒說完",
    missing: [],
    passed: true,
  },
  A04: {
    files: ["routing.test.ts"],
    names: "補充尚未開始|原需求已開始|沒說完",
    missing: [],
    passed: true,
    note: "真模型案例驗證同主題合併與獨立主題拆開；不代表已開發兩張PR。",
  },
  A05: {
    files: ["policy.test.ts", "routing.test.ts"],
    names: "安靜一分鐘|沒說完",
    missing: ["真實pg-boss在60／300秒邊界的時間軸，不只純函式判斷"],
  },
  A06: {
    files: ["workflow.test.ts", "api.test.ts", "pr-evidence.test.ts"],
    names: "重送|重複核准|GitHub 簽章|重試已有 PR|既有分支",
    missing: [
      "遠端Issue建立後中斷的完整重試",
      "真實LINE重送對同一Issue／有效PR的遠端去重",
    ],
  },
  A07: {
    files: ["routing.test.ts", "execution.test.ts"],
    names: "補充尚未開始|原需求已開始|新版需求同步",
    missing: ["PR完成後追加需求建立後續任務的實測"],
  },
  A08: {
    files: ["chat.test.ts", "execution.test.ts"],
    names: "切換模式|停用派工|辨識途中|設定.*變更|驗證期間修改",
    missing: ["進行中全域暫停／群組停用後舊模型結果回來的完整競態"],
  },
  A09: {
    files: [
      "policy.test.ts",
      "triage.test.ts",
      "execution.test.ts",
      "routing.test.ts",
    ],
    names: "敏感|已配對.*管理者",
    missing: [
      "付款、部署、權限、刪資料、敏感路徑全部情境與聊天假核准的逐項真模型覆蓋",
    ],
  },
  B01: {
    files: ["chat.test.ts", "image-content.test.ts"],
    names: "簽章收訊|實際解碼",
    missing: [
      "真實LINE圖片下載與message ID",
      "聊天室縮圖及放大圖實際瀏覽器驗收",
    ],
  },
  B02: {
    files: [
      "execution.test.ts",
      "image-content.test.ts",
      "image-context.test.ts",
    ],
    names: "B02|圖片需求改版|GIF 保留",
    missing: ["真實Codex開發／修復／審查對相同圖片雜湊的run記錄及變更結果"],
  },
  B03: {
    files: ["chat.test.ts"],
    names: "簽章收訊、指令引用圖片|引用其他群組",
    missing: [],
    passed: true,
    note: "隔離簽章收訊與分類器替身證明只採指定引用；非真LINE發送。",
  },
  B04: {
    files: ["image-context.test.ts"],
    names: "兩張候選|候選超過",
    missing: ["先圖後文／先文後圖／多圖夾聊天的同批配對組合"],
  },
  B05: {
    files: ["image-content.test.ts"],
    names: "實際解碼",
    missing: [
      "清晰圖片正向固定三次，目前紅框中文只有一輪",
      "箭頭、長截圖、相近色碼的分別地面答案",
    ],
  },
  B06: {
    files: ["image-context.test.ts", "triage.test.ts"],
    names: "單純貼圖|無法辨識|無法取得",
    missing: ["裁切、互相矛盾、僅有圖片但帶不明修改意圖的分別負向案例"],
    note: "模糊圖三輪已通過；不能擴稱所有圖片負向情境。",
  },
  B07: {
    files: ["image-content.test.ts", "chat.test.ts"],
    names: "B07|下載失敗只重試三次",
    missing: ["惡劣圖片反覆失敗時pg-boss仍繼續其他群組的背景工作證據"],
  },
  B08: {
    files: ["policy.test.ts", "proxy.test.ts", "containers.test.ts"],
    names: "敏感需求|模型、遠端工具|非 root",
    missing: ["提示注入圖片固定三輪及實際開發工具層不讀取機密／不合併PR的證據"],
  },
  B09: {
    files: [
      "chat.test.ts",
      "execution.test.ts",
      "image-context.test.ts",
      "maintenance.test.ts",
    ],
    names: "撤回|下載途中",
    missing: ["真實圖片下載中撤回與真Codex開發中撤回的端到端回放"],
  },
  C01: {
    files: ["context-evidence.test.ts"],
    names: "C01/C02",
    missing: [],
    passed: true,
    note: "來源分類與API證據為真資料庫測試；UI來源區另有瀏覽器截圖。",
  },
  C02: {
    files: ["retrieval.test.ts", "context-evidence.test.ts"],
    names: "上週對話|C01/C02",
    missing: ["真實開發採用該獨特數值並量測after畫面，對應D05"],
  },
  C03: {
    files: ["retrieval.test.ts", "outcomes.test.ts"],
    names: "停用|零呼叫",
    missing: [],
    passed: true,
    note: "真BGE/Codex同快照RAG關閉對照已完成，僅分類層。",
  },
  C04: {
    files: ["image-context.test.ts"],
    names: "七天前圖片|兩張候選|雜湊",
    missing: [],
    passed: true,
    note: "真模型unique與ambiguous分別通過；開發傳圖另看B02。",
  },
  C05: {
    files: ["retrieval.test.ts", "routing.test.ts"],
    names: "上週對話|原需求已開始",
    missing: ["100天前任務的追加需求分支；目前真模型只驗證duplicate"],
  },
  C06: {
    files: ["routing.test.ts", "retrieval.test.ts"],
    names: "群組記憶|專案記憶|補建",
    missing: ["實際重啟服務後同規範仍生效，且來源標資料庫而非向量"],
  },
  C07: {
    files: ["repo-index.test.ts"],
    names: "完整的指定版本|變更目標版本|過期版本",
    missing: [],
    passed: true,
    note: "以真PG與模型替身驗證版本公開邊界；超過5000的缺口另列E02。",
  },
  C08: {
    files: ["outcomes.test.ts"],
    names: "回填舊失敗",
    missing: [
      "開發／審查實際取得相同失敗結果",
      "產生、實際開圖檢視手機截圖；舊verify-rag-flow已修假通過但本輪未重跑",
    ],
  },
  C09: {
    files: ["retrieval.test.ts"],
    names: "候選依相似度",
    missing: ["錯誤誘餌與無關相似來源的真模型拒絕案例"],
    note: "相互矛盾舊規格的真模型待確認已通過。",
  },
  C10: {
    files: ["retrieval.test.ts", "outcomes.test.ts", "triage.test.ts"],
    names: "異群|未綁定|已解除綁定|兩群組",
    missing: [],
    passed: true,
  },
  C11: {
    files: [
      "retrieval.test.ts",
      "image-context.test.ts",
      "maintenance.test.ts",
      "execution.test.ts",
    ],
    names: "撤回|保存期|到期|C11",
    missing: [
      "明確29／30／31天逐個邊界與同時原文、原圖、摘要、向量及快取的完整斷言",
    ],
  },
  C12: {
    files: ["embedder.test.ts", "retrieval.test.ts", "image-context.test.ts"],
    names: "逾時|格式|故障|離線|恢復",
    missing: ["真實模型故障及恢復期間的看板／收訊／派工整合證據"],
    note: "真模型分類器加不可達模型埠已證明獨立需求可排程、依賴歷史需確認。",
  },
  D01: {
    files: [],
    missing: ["真LINE任務尚未開始", "PR head、merge SHA及指定文案after畫面"],
  },
  D02: {
    files: [],
    missing: [
      "真LINE框選圖任務尚未開始",
      "Part Spec基底+96px的PR head與merge SHA量測",
    ],
  },
  D03: {
    files: [],
    missing: [
      "手機修復任務尚未開始",
      "修復後四視窗／十資料情境及Check In、頁尾、橫向溢出實際開圖",
    ],
  },
  D04: {
    files: [],
    missing: ["狀態文字／色彩修復任務尚未開始", "修復後對比量測與實際開圖"],
  },
  D05: {
    files: [],
    missing: ["實際採用RAG尺寸／色碼改程式的PR", "before/head/merge畫面與量測"],
  },
  D06: {
    files: [],
    missing: [
      "前一任務合併後新main／新索引的追加真LINE任務",
      "merge SHA預覽與驗收",
    ],
  },
  E01: {
    files: ["chat.test.ts", "workflow.test.ts"],
    names: "大量訊息|重送|先到",
    missing: ["1000筆合法消息進入實際pg-boss並在中斷後完整恢復、沒有重複派工"],
  },
  E02: {
    files: ["image-context.test.ts", "repo-index.test.ts"],
    names: "近期訊息與任務超過上限|候選超過|專案達上限|E02",
    missing: ["超限且未取到指定來源時，正式high模型不得猜測的完整案例"],
    note: "5001段落缺口已修為limited，真tar/PG驗證總數與分類器替身可見理由；不是完整repo或真分類模型已驗。",
  },
  E03: {
    files: ["workflow.test.ts", "execution.test.ts", "pr-evidence.test.ts"],
    names: "重送|快速重新啟動|核對遠端|既有分支|重試已有 PR",
    missing: [
      "收訊交易前後kill進程",
      "Issue建立、push、PR建立前後實際故障點與遠端去重",
    ],
  },
  E04: {
    files: [
      "workflow.test.ts",
      "execution.test.ts",
      "chat.test.ts",
      "image-context.test.ts",
      "acceptance-races.test.ts",
    ],
    names:
      "核准需符合|進行中取消|核對遠端 PR 時取消|版本改變|撤回|切換模式再切回|E04",
    missing: [],
    passed: true,
    note: "已有真PG20並行核准及amend/cancel/unsend競爭；遠端完成晚到以可控替身重現，不是正式LINE故障。",
  },
  E05: {
    files: ["execution.test.ts"],
    names: "驗證失敗只修復一次|審查失敗摘要|測試修改候選內容|只發布通過",
    missing: [],
    passed: true,
    note: "真PG狀態機加Runner/GitHub替身；test fail與review reject均2次codeCalls，candidate tamper零發布。",
  },
  E06: {
    files: [
      "archive-download.test.ts",
      "proxy.test.ts",
      "chat.test.ts",
      "triage.test.ts",
      "observation.test.ts",
    ],
    names: "逾時|停滯|取消|限流|失敗三次|下載失敗|連線診斷|未完成",
    missing: [
      "GitHub Issue／PR寫入端401／403／429／5xx與回應遺失的重試矩陣",
      "LINE圖片傳輸中途斷流與所有供應商恢復後再成功的整合證據",
    ],
  },
  E07: {
    files: ["acceptance-resources.test.ts"],
    names: "E07",
    missing: [
      "OOM／PID／ENOSPC經真Execution狀態機標失敗、通知、下一任務繼續；目前只驗容器引擎回收",
    ],
    note: "資源故障使用64MiB／16PID／8MiB獨立容器，不以填滿主機重現。",
  },
  E08: {
    files: ["workflow.test.ts", "triage.test.ts", "proxy.test.ts"],
    names: "並行預留|額度不足|額度與取消",
    missing: [
      "訂閱配額耗盡回應到budget_wait、零付費API fallback、保持收訊與恢復後重試",
    ],
  },
  E09: {
    files: [
      "source-cache.test.ts",
      "acceptance-cache.test.ts",
      "execution.test.ts",
    ],
    names: "E09|相同版本不抓取|記錄的基底",
    missing: ["真實專案準備／開發分段耗時重測；目前為1MiB本機Git fixture"],
    note: "首次snapshot腐損錯誤已留ledger，修復後完整性檢查通過。",
  },
  E10: {
    files: [
      "acceptance-cache.test.ts",
      "execution.test.ts",
      "source-cache.test.ts",
    ],
    names: "E10|存取權失效|副本",
    missing: [],
    passed: true,
    note: "真Docker快取／副本隔離，加GitHub權限403替身；未撤銷正式App權限。",
  },
  E11: {
    files: ["instance-isolation.test.ts", "execution.test.ts"],
    names: "隔離|命名|啟動|真實 Docker|快速重新啟動",
    missing: [
      "真正runner程序kill→restart與同時運轉正式哨兵的完整時間軸；現為真Docker cleanup/cancel/dispose和recoverInterrupted替身",
    ],
  },
  E12: {
    files: [
      "api.test.ts",
      "chat.test.ts",
      "containers.test.ts",
      "repository-safety.test.ts",
      "proxy.test.ts",
      "context-evidence.test.ts",
    ],
    names:
      "非管理者|未登入|其他群組|主金鑰|socket|不能改寫|敏感路徑|憑證|遠端工具|E12",
    missing: [
      "惡意repo文字實際進入真Codex後，嘗試讀機密／操作Docker／繞過審核的執行證據",
    ],
  },
};
const records = definitions.map(([, id, requirement]) => {
  const n = notes[id];
  if (!n) throw new Error(`未盤點案例 ${id}`);
  const selected = tests.filter(
    (test: { file: string; fullName: string }) =>
      n.files.includes(test.file) &&
      (!n.names || new RegExp(n.names).test(test.fullName)),
  );
  const real = model.cases.filter(
    (test: { id: string }) => test.id === id || test.id.startsWith(id + "-"),
  );
  const exploratory = real.length > 0 && model.environment?.effort !== "high";
  const complete = n.passed && !exploratory;
  const subcases = suites.filter((row: { id: string }) =>
    row.id.startsWith(id + "."),
  );
  return {
    案例: id,
    必要條件: requirement,
    狀態: complete ? "通過" : "未測",
    整案判定: complete
      ? "必要條件在下列明列的驗收層已具證據，不擴稱真LINE端到端"
      : "只有部分子項、探索設定或基底證據，尚未完成此整案",
    驗證層: [
      ...new Set([
        ...(selected.length || subcases.length ? ["隔離", "服務替身"] : []),
        ...(real.length ? ["真實模型"] : []),
        ...(id.startsWith("D") || id === "C01"
          ? ["實際瀏覽器（僅基底／證據介面）"]
          : []),
      ]),
    ],
    真實LINE: "未測，本輪尚未從正式群組開始",
    模型設定: real.length
      ? {
          模型: model.environment.model,
          推理強度: model.environment.effort,
          屬於探索: exploratory,
          正式推理強度: "high",
        }
      : null,
    說明: n.note ?? "",
    已有測試證據: selected.map(
      (test: { file: string; fullName: string; status: string }) => ({
        檔案: test.file,
        測試: test.fullName,
        結果: test.status === "passed" ? "通過" : "失敗",
        報告: regressionPath,
      }),
    ),
    真模型子案: real.map(
      (test: {
        id: string;
        iteration: number;
        status: string;
        expected: string;
        modelRuns?: { threadId?: string }[];
      }) => ({
        子案: test.id,
        輪次: test.iteration,
        結果: test.status,
        驗證範圍: test.expected,
        執行緒: test.modelRuns?.map((r) => r.threadId).filter(Boolean) ?? [],
        報告: modelPath,
      }),
    ),
    隔離故障子案: subcases.map(
      (row: {
        id: string;
        suite: string;
        firstFailure?: { detail: string } | null;
        firstResult?: { status: string };
        latestResult?: { status: string; artifacts: unknown[] };
        expected: string[];
      }) => ({
        子案: row.id,
        驗證範圍: row.expected,
        首次結果: row.firstResult?.status,
        首次失敗保留: row.firstFailure?.detail ?? null,
        最新結果:
          row.latestResult?.status === "passed"
            ? "通過"
            : row.latestResult?.status === "failed"
              ? "失敗"
              : "受阻",
        報告: resolve(output, row.suite, "summary.json"),
      }),
    ),
    畫面證據: id.startsWith("D")
      ? {
          基底: resolve(output, "基底/report.json"),
          視覺抽查: resolve(output, "基底/視覺抽查紀錄.md"),
          判讀: "只有before基底：40組core通過、完整strict僅6組通過；不得視為D修復完成或after/merge證據",
        }
      : null,
    尚缺關鍵子項: [
      ...n.missing,
      ...(exploratory
        ? ["目前真模型effort=low只屬探索；仍需依正式high設定重跑"]
        : []),
    ],
  };
});
if (records.length !== 48) throw new Error(`案例數量錯誤：${records.length}`);
const report = {
  建立時間: new Date().toISOString(),
  規格: resolve(root, "docs/specs/full-flow-acceptance.md"),
  判定規則: [
    "這是證據盤點快照，不是整體完成宣告",
    "整案只有必要子項齊全才通過；有部分測試者仍可標未測",
    "真實模型分類成功不能取代程式修改、PR與瀏覽器驗收",
    "故障測試的供應商替身均明列，不冒充真實外部故障",
    "首次失敗與後來修復通過分開保留",
  ],
  數量: Object.fromEntries(
    ["通過", "失敗", "受阻", "未測"].map((status) => [
      status,
      records.filter((r) => r.狀態 === status).length,
    ]),
  ),
  全套回歸: {
    報告: regressionPath,
    總數: regression.numTotalTests,
    通過: regression.numPassedTests,
    失敗: regression.numFailedTests,
    界線: "此報告早於新boundary測試；boundary另依附加ledger",
  },
  案例: records,
};
const path = resolve(output, "案例證據索引.json");
writeFileSync(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ 檔案: path, 數量: report.數量 }));
