import { validateLabel } from "../shared/project-setup.js";
import { baselineFailurePlain } from "../shared/failure-text.js";
import { upstreamFailureText, type UpstreamFailure } from "../shared/upstream-failure.js";
import { redact } from "./policy.js";
import { clip } from "./pr-body.js";

/**
 * 任務失敗的白話說明（#22）。
 *
 * 執行失敗時，原始錯誤（含完整輸出與堆疊）只寫進執行紀錄供除錯；
 * 看板摘要、管理者通知與群組訊息一律用這裡整理過的分類、說明與建議處理。
 */
export type FailureCategory =
  "transient" | "environment" | "project" | "config" | "system";

export const categoryLabels: Record<FailureCategory, string> = {
  transient: "暫時性問題",
  environment: "環境問題",
  project: "專案問題",
  config: "設定問題",
  system: "系統問題",
};

export interface FailureExplanation {
  category: FailureCategory;
  /** 發生什麼事，一句話。 */
  plain: string;
  /** 建議誰做什麼。 */
  action: string;
  /** 群組看得懂、不含任何原始錯誤的處理方式。 */
  group: string;
  /** 從原始輸出挑出的錯誤重點；已去除堆疊與內部路徑、遮蔽機密。 */
  detail: string;
  /** 群組也要看到的整理過內容（例如基底驗證失敗的測試名稱）；沒有時不附。 */
  groupDetail?: string;
}

/**
 * 錯誤訊息裡「系統整理過的報告」與「原始輸出結尾」的分隔（基底驗證失敗用，#248）。
 * 分隔前是已遮蔽的失敗測試清單與上次通過的 commit，整段放進錯誤重點；分隔後照舊只挑錯誤行。
 */
export const reportTailMark = "\n輸出結尾：\n";

type Advice = string | ((verify: string) => string);

/** 單次執行時間用完的白話說明。 */
export const timeoutPlain = "工作沒有在單次執行的時間限制內完成";

interface Rule {
  category: FailureCategory;
  test: (body: string, phase: string) => boolean;
  plain: string;
  action: Advice;
  group: string;
  /**
   * 專案環境驗證失敗時的建議處理。驗證沒有「重試」按鈕也沒有任務的執行紀錄，
   * 建議要對應專案頁的按鈕（「驗證環境」「AI 自動設定並驗證」、進階設定）；沒寫時依分類套用預設。
   */
  validation?: Advice;
  /** 訊息本身就是整理過的說明（審查意見、上限說明），整段保留而不是只挑錯誤行。 */
  keep?: boolean;
  /** 從堆疊挑出專案原始碼的位置放在錯誤重點最前面（堆疊行本身不放進摘要）。 */
  locate?: boolean;
}

/**
 * 堆疊中第一個專案原始碼的位置（.NET 的「in /workspace/路徑:line N」），排除建置產物。
 * 只回傳工作目錄內的相對路徑與行號，不含其他堆疊內容。
 */
export function projectSourceLine(output: string): string | null {
  for (const m of output.matchAll(
    /\bin \/workspace\/([^\s:]+\.(?:cs|vb|fs)):line (\d+)/g,
  )) {
    if (/(^|\/)(?:obj|bin)\//.test(m[1])) continue;
    return `${m[1]} 第 ${m[2]} 行`;
  }
  return null;
}

/** 失敗發生在哪裡：任務執行，或專案頁的環境驗證。 */
export type FailureContext = "task" | "validation";

const validationDefaults: Record<FailureCategory, Advice> = {
  transient: (verify) => `通常稍後就會恢復，請稍後在專案頁${verify}`,
  environment: (verify) =>
    `確認工作映像有需要的工具，或在專案頁進階設定改安裝指令、映像後${verify}`,
  project: "修好儲存庫的建置或測試，或在進階設定調整測試指令後重新驗證",
  config: (verify) => `依錯誤重點補上設定或權限後，在專案頁${verify}`,
  system: (verify) => `稍後在專案頁${verify}；仍發生時回報給維護者`,
};
const matches = (pattern: RegExp) => (body: string) => pattern.test(body);

// 規則依序比對，先中先贏：先認「專案／設定」這類明確的訊息，
// 再認暫時性錯誤，避免測試輸出裡剛好出現的 ECONNREFUSED 被誤當成網路問題而重試。
const rules: Rule[] = [
  {
    category: "project",
    test: matches(/^沒有可提交的程式變更，Codex 未確認需求已符合/),
    plain: "Codex 沒有交付變更，也未確認需求已符合",
    action: "請到看板查看 Codex 的說明，補足所需資訊後再重試",
    group: "這次還沒完成修改，請管理者查看原因後處理。",
    keep: true,
  },
  {
    category: "environment",
    test: matches(/測試環境問題/),
    plain: "測試需要的環境（例如 SQL Server）沒有啟動成功，不是程式沒過",
    action: (verify) => `請到看板專案頁${verify}，確認工作映像與測試設定`,
    group: "測試環境沒有啟動成功，請管理者處理專案的測試環境。",
    keep: true,
  },
  {
    category: "project",
    test: matches(/^SQL Server 審查複驗未通過/),
    plain: "相同候選內容在獨立 SQL Server 測試中未通過",
    action: "請依審查複驗的輸出檢查測試斷言與資料庫前置條件",
    group: "獨立 SQL Server 測試沒有通過，請管理者檢查複驗結果。",
  },
  // 測試在 Linux 容器仍連 LocalDB：系統的導向只能改寫檔案裡的連線字串，程式碼另外組出的 LocalDB 連線改不到。
  // 要排在暫時性規則前：SqlClient 的訊息含「network-related」，不能當成網路問題重試。
  {
    category: "project",
    test: matches(
      /error: 25 - Connection string is not valid|LocalDB is not supported on this platform/i,
    ),
    plain:
      "測試程式在容器裡仍連到 LocalDB（只有 Windows 才有），系統沒辦法自動改成容器內的 SQL Server",
    action:
      "請讓測試在環境變數 AGENTFLOW_SQLSERVER_CONNECTION 有值時改用它（容器內 SQL Server 的連線字串），沒有時才用 LocalDB；錯誤重點的「位置」就是要改的地方，改好後重新驗證專案再重試",
    validation: (verify) =>
      `修改錯誤重點「位置」指出的測試程式：有環境變數 AGENTFLOW_SQLSERVER_CONNECTION 時改用它連容器內的 SQL Server，沒有時才用 LocalDB；合併後${verify}`,
    group: "專案的測試寫死只能在 Windows 使用的資料庫，請管理者調整測試設定。",
    locate: true,
  },
  // 系統套件（#18）：要排在 403、安裝失敗等通用規則前，代理擋下來源時輸出裡也會有 403。
  {
    category: "config",
    test: matches(
      /未通過固定規則|下載來源白名單無效|系統套件安裝失敗[\s\S]*(?:\b403\b|Forbidden)/,
    ),
    plain:
      "系統套件的安裝計畫或下載來源沒有通過目前的白名單（可能是白名單在驗證後被改過）",
    action: (verify) =>
      `請到「系統 → 下載來源白名單」確認需要的來源，或到專案頁${verify}`,
    validation: (verify) =>
      `到「系統 → 下載來源白名單」確認需要的來源，或在專案頁${verify}`,
    group: "專案需要的系統套件來源目前不在允許清單，請管理者處理。",
  },
  {
    category: "environment",
    test: matches(/系統套件安裝失敗|衍生映像[^。\n]{0,20}(?:不屬於|設定異常)/),
    plain: "安裝前審查放行的系統套件沒有裝起來",
    action: (verify) =>
      `到執行紀錄查看安裝輸出（套件名稱、版本或來源），再到專案頁${verify}後重試`,
    validation: (verify) =>
      `依錯誤重點檢查套件名稱、版本或來源，再到專案頁${verify}`,
    group: "專案需要的系統工具沒有裝起來，請管理者處理專案的執行環境。",
  },
  {
    category: "project",
    test: matches(/一次自動修復後仍未通過驗證|驗證未通過/),
    plain: "AI 修改後，測試或獨立審查仍沒有通過",
    action:
      "到執行紀錄查看沒過的測試輸出與審查意見；需求或驗收要調整時，修改需求後再重試",
    group: "修改後的測試或審查沒有通過，請管理者查看原因後處理。",
    keep: true,
  },
  {
    category: "project",
    test: matches(/目標分支基底驗證失敗/),
    plain: baselineFailurePlain,
    action:
      "在看板按「請 AI 修好目標分支」建立修復任務（仍要人工核准），或自行修好目標分支的建置與測試（或改用其他分支）後再到看板重試",
    group:
      "目標分支本身的建置或測試沒有通過，請管理者在看板請 AI 修好目標分支，或先修好專案再重試。",
  },
  {
    category: "project",
    test: matches(/沒有找到可執行的測試/),
    plain: "測試命令沒有跑到任何測試，不能當成測試通過",
    action: "請管理者到看板專案頁調整測試命令或測試範圍，重新驗證後重試",
    validation: "在專案頁進階設定調整測試指令或測試範圍後重新驗證",
    group: "專案的測試命令沒有跑到任何測試，請管理者調整專案的測試設定。",
  },
  {
    category: "project",
    test: matches(/修改了專案檔案/),
    plain: "安裝或基底驗證的過程改動了專案檔案",
    action:
      "把建置產物加入專案頁進階設定的「收集時排除」或專案的 .gitignore，重新驗證專案後重試",
    validation:
      "把建置產物加入專案頁進階設定的「收集時排除」或專案的 .gitignore 後重新驗證",
    group: "專案的安裝或測試會改動專案檔案，請管理者調整專案設定。",
  },
  {
    category: "project",
    test: matches(/超過[^。\n]{0,40}上限[\s\S]*未發布/),
    plain: "這次修改的檔案太多或太大，超過交付上限，沒有開出 PR",
    action: "依錯誤重點的建議調整（例如排除建置產物）後重試",
    group: "這次修改的內容超過交付上限，請管理者依看板上的說明調整後重試。",
    keep: true,
  },
  {
    category: "project",
    // 逾時前已收集到修改（execution.ts 加上前綴）：重試會從測試與獨立審查接續，縮小需求範圍不是對的處理（#241）。
    test: matches(/^修改已保留，/),
    plain: "時間用完前修改已完成，修改已保留，但測試或獨立審查還沒做完",
    action: "按「重試」會沿用保留的修改，從測試與獨立審查接續",
    group: "管理者重試後會從驗證接續。",
  },
  {
    category: "project",
    // 第一次修改驗證沒過、唯一一次自動修復途中逾時（execution.ts 加上前綴）：重試直接修復，不重做驗證（#241）。
    test: matches(/^修改與審查意見已保留，/),
    plain:
      "時間用完前第一次修改的驗證沒有通過，修改與審查意見已保留，唯一一次自動修復還沒做完",
    action: "按「重試」會沿用保留的修改與審查意見，直接進行唯一一次自動修復",
    group: "管理者重試後會接著自動修復。",
  },
  {
    category: "project",
    // 訂閱代理在階段期限到了會回「訂閱階段已超過期限」（runner-main、subscription-broker）。
    test: matches(/超過\s*\d*\s*分鐘限制|超過時間限制|執行超過時間|已超過期限/),
    plain: timeoutPlain,
    // 單次執行時間上限是 30 分鐘；已經設成 30 的管理者調不上去，先建議縮小範圍。
    action:
      "縮小需求範圍或拆成較小的需求後重試；單次執行時間可在「設定」調整（上限 30 分鐘）",
    validation: (verify) =>
      `稍後在專案頁${verify}；仍逾時請在進階設定縮小測試範圍`,
    group: "工作沒有在時間限制內完成，請管理者縮小範圍或調整時間限制後重試。",
  },
  {
    category: "config",
    // 本機代理以 429 表示這次執行的預算用完；不能當成暫時性錯誤重試，否則等於繞過每次任務預算。
    test: matches(
      /額度(?:已達上限|不足|用完)|超過單次預估上限|今日執行次數|usage limit|insufficient_quota|\b429\b|Too Many Requests|rate.?limit/i,
    ),
    plain: "AI 額度不足或呼叫次數受到限制",
    action:
      "請管理者到「設定」確認每次任務預算、每日額度與次數，額度足夠後到看板重試",
    validation: (verify) =>
      `到「設定」確認 AI 額度與每日次數，額度足夠後在專案頁${verify}`,
    group: "AI 額度不足，請管理者處理額度。",
  },
  {
    category: "config",
    test: matches(
      /\b40[13]\b|Unauthorized|Forbidden|Bad credentials|Resource not accessible|invalid[_ ]api[_ ]key|authentication (?:failed|required)|權限不足|沒有權限|未授權|登入已過期/i,
    ),
    plain: "外部服務拒絕存取，可能是登入過期、憑證失效或權限不足",
    action:
      "請管理者到看板檢查 GitHub 授權、Codex 登入、API 金鑰或套件來源的權限，修正後重試",
    validation: (verify) =>
      `檢查 GitHub 授權、Codex 登入、API 金鑰或私有套件來源的權限，修正後在專案頁${verify}`,
    group: "外部服務的登入或權限有問題，請管理者檢查服務授權。",
  },
  {
    category: "config",
    test: matches(
      /尚未登記資料庫連線|缺少[^。\n]{0,12}(?:連線|憑證|金鑰|權杖)|(?:連線|憑證|金鑰)尚未設定/,
    ),
    plain: "缺少必要的連線或憑證設定",
    action: "請管理者到看板專案頁補上連線或憑證設定後重試",
    validation: (verify) => `在專案頁補上連線或憑證設定後${verify}`,
    group: "專案缺少連線或憑證設定，請管理者到看板補上。",
  },
  {
    category: "config",
    // 執行中途停止的原因（Execution.assertCurrent 的各種訊息），以及容器被停時執行器回的「工作已取消」。
    test: matches(
      /任務已取消|需求版本已改變|系統已暫停派工|群組已停用|群組已不再綁定|目標專案已改變|專案已停用|專案設定已變更|工作已取消|環境設定已變更|請重新驗證|目標專案尚未確認/,
    ),
    plain: "執行期間任務、群組或專案的設定被變更，已停止這次執行",
    action: "到看板確認目前的需求版本、專案與群組設定後再重試",
    validation: (verify) => `確認專案設定後，在專案頁${verify}`,
    group: "處理期間設定有變更，請管理者確認設定後重試。",
  },
  {
    category: "environment",
    test: matches(
      /command not found|: not found|工作容器可能缺少|No such image|找不到工作映像|映像版本過舊/i,
    ),
    plain: "工作容器缺少需要的指令、工具或映像",
    action:
      "請管理者確認工作映像已安裝對應工具（或改用專案專屬映像），重新驗證專案後重試",
    validation: (verify) =>
      `確認工作映像已安裝對應工具，或在專案頁進階設定改用專案專屬映像、調整指令後${verify}`,
    group: "工作環境缺少需要的工具，請管理者處理專案的執行環境。",
  },
  {
    category: "transient",
    test: matches(
      /執行器[^。\n]{0,12}(?:連線失敗|回應不是完整的 JSON)|工作輸入不是完整的 JSON|容器輸入連線失敗|專案快取輸入連線失敗/,
    ),
    plain: "和執行器的連線中斷或逾時",
    action: "通常稍後就會恢復；系統會先自動重試，仍失敗時到看板按「重試」",
    group: "連線暫時中斷，可以稍後到看板按「重試」。",
  },
  {
    category: "transient",
    test: matches(
      /Codex 執行失敗|獨立審查失敗|AI 安裝審查失敗|@openai\/codex-sdk|Codex Exec exited|stream (?:disconnected|error)|Reconnecting|exceeded retry limit|訂閱(?:推論|上游)連線失敗|訂閱登入讀取或刷新失敗|無法確認(?: Codex )?訂閱額度|AI 環境設定失敗[\s\S]*(?:AbortSignal|AbortError|aborted|Timeout\._onTimeout|timeout)/i,
    ),
    plain: "AI 服務回應中斷或逾時",
    action: "通常稍後就會恢復；系統會先自動重試，仍失敗時到看板按「重試」",
    group: "AI 服務暫時中斷，可以稍後到看板按「重試」。",
  },
  {
    category: "transient",
    test: matches(
      /連線失敗|fetch failed|FETCH_FAILED|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_|socket hang up|network error|連線逾時或中止|\b(?:502|503|504)\b|Bad Gateway|Service Unavailable|Gateway Timeout/i,
    ),
    plain: "網路連線中斷或外部服務暫時無法回應",
    action: "通常稍後就會恢復；系統會先自動重試，仍失敗時到看板按「重試」",
    group: "網路暫時中斷，可以稍後到看板按「重試」。",
  },
  {
    category: "environment",
    test: (body, phase) => phase === "install" || /安裝失敗/.test(body),
    plain: "安裝依賴失敗，程式無法建置或執行",
    action:
      "依錯誤重點修正套件設定（名稱、版本、套件來源或私有套件權限），或到看板專案頁重新驗證環境後重試",
    validation: (verify) =>
      `修正套件設定（名稱、版本、套件來源或私有套件權限），或在進階設定改安裝指令或映像後${verify}`,
    group: "專案的依賴安裝失敗，請管理者處理專案的套件設定。",
  },
  {
    category: "project",
    test: (_body, phase) => phase === "test",
    plain: "建置或測試失敗",
    action: "到執行紀錄查看測試輸出，修好專案的建置或測試後重試",
    validation: "修好儲存庫的建置或測試，或在進階設定調整測試指令後重新驗證",
    group: "專案的建置或測試沒有通過，請管理者查看原因後處理。",
  },
];
const fallback: Rule = {
  category: "system",
  test: () => true,
  plain: "系統發生預期外的錯誤",
  action: "請管理者查看執行紀錄；重試仍發生時回報給維護者",
  group: "系統發生預期外的錯誤，請管理者查看執行紀錄。",
};

const ansi = /\x1b\[[0-9;]*[a-zA-Z]/g;
// 堆疊與執行時期的內部路徑：只留在執行紀錄。
const internalPath =
  /(?:file:\/\/\/|node:internal\/|\/opt\/agentflow\/|\/app\/(?:dist|server|node_modules)\/)[^\s)'"]*/g;
const noise = [
  /^at\s/, // 堆疊框架
  /^\^+$/, // Node 錯誤標示的箭頭
  /^Node\.js v\d/,
  /^throw\s/, // 錯誤位置附帶的原始碼
  /^(?:\[內部路徑\][\s:\d]*)+$/,
];

/** 去除 `file:///…` 堆疊、Node 錯誤位置與執行器內部路徑；保留真正的錯誤文字。 */
export function stripInternals(text: string) {
  return text
    .replace(ansi, "")
    .replace(/\bthrow new \w*Error\b[^\n]*/g, "")
    .replace(internalPath, "[內部路徑]")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !noise.some((n) => n.test(line)))
    .join("\n");
}

// 有意義的錯誤行：套件管理器、編譯器、測試工具常見的錯誤開頭。
const meaningful =
  /npm ERR!|npm error|\berror\s+[A-Z]{2,}\d+|\b[A-Z]{2,}\d{3,}:|^ERROR\b|^error\b|^fatal:|^E:\s|Error:|Exception\b|ERR_[A-Z_]+|\bFAILED\b|\bfailed\b|失敗|錯誤|找不到|無法/i;

/**
 * 從安裝或執行輸出（stdout 與 stderr 合併）挑出最後幾行有意義的錯誤；
 * 都沒有時取最後兩行。完整輸出仍保存在執行紀錄。
 */
export function keyErrorLines(output: string, max = 3, limit = 600) {
  const lines = stripInternals(redact(output)).split("\n").filter(Boolean);
  const picked: string[] = [];
  for (let i = lines.length - 1; i >= 0 && picked.length < max; i--) {
    const line = lines[i].slice(0, 300);
    if (meaningful.test(line) && !picked.includes(line)) picked.unshift(line);
  }
  const chosen = picked.length ? picked : lines.slice(-2);
  const text = chosen.join("\n");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// 例外訊息、斷言結果與失敗的測試名稱；不含「at …」堆疊行。
const errorMessage =
  /(?:Exception|Error)(?:\s*\(0x[0-9a-f]+\))?:\s*\S|Error Message:|Assert\.\w+\(\)\s*Failure|^\s*(?:Expected|Actual|Received):|\[FAIL\]|^\s*Failed\s+\S|^\s*✕|^\s*×|AssertionError/i;

/**
 * 驗證或測試失敗時保存的錯誤：先放整段輸出裡的例外訊息與失敗測試（最多 8 行），
 * 再接輸出的結尾。只取結尾時，真正的錯誤訊息常被後面的堆疊擠掉（驗收時 SQL 錯誤就看不到）。
 */
export function failureDigest(output: string, limit = 2000) {
  const text = redact(output.replace(ansi, ""));
  const picked: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^at\s/.test(trimmed) || !errorMessage.test(line)) continue;
    const short = trimmed.slice(0, 400);
    if (!picked.includes(short)) picked.push(short);
    if (picked.length >= 8) break;
  }
  const head = picked.join("\n");
  const room = Math.max(400, limit - head.length - 20);
  const tail = text.length > room ? `…${text.slice(-room)}` : text;
  return head ? `${head}\n---\n${tail}` : tail;
}

/**
 * 依失敗階段與原始錯誤分類，並附上白話說明與建議處理。
 * `phase` 是執行階段代號（install、test、code…），`raw` 是原始錯誤訊息。
 * `context` 為 validation 時，建議處理改成專案頁上找得到的按鈕與設定。
 */
export function classifyFailure(
  raw: string,
  phase = "",
  context: FailureContext = "task",
  project?: Parameters<typeof validateLabel>[0],
  upstreamFailure?: UpstreamFailure,
): FailureExplanation {
  const body = redact(raw.replace(ansi, ""));
  const rule = rules.find((r) => r.test(body, phase)) ?? fallback;
  if (upstreamFailure)
    return {
      category: rule.category,
      plain: upstreamFailureText(upstreamFailure),
      detail: "未使用其他計費方式",
      action: "請查看這次執行紀錄的訂閱失敗原因，再決定是否重試",
      group: "請管理者查看這次執行紀錄，再決定是否重試。",
    };
  // 摘要只放錯誤重點；開頭的「安裝失敗：」這類前綴已經由白話說明表達。
  const stripped = `\n${body
    .replace(/^\s*[\p{Script=Han}A-Za-z ]{1,16}?(?:失敗|未通過驗證)：/u, "")
    .trim()}`;
  const at = stripped.indexOf(reportTailMark);
  const report = at >= 0 ? stripped.slice(0, at).trim() : "";
  const lines = (
    at >= 0 ? stripped.slice(at + reportTailMark.length) : stripped
  ).trim();
  let detail = rule.keep
    ? clip(stripInternals(lines), 900, "…（完整內容見執行紀錄）")
    : keyErrorLines(
        lines,
        rule.category === "project" || rule.category === "environment" ? 4 : 2,
        900,
      );
  const advice =
    context === "validation"
      ? (rule.validation ?? validationDefaults[rule.category])
      : rule.action;
  const where = rule.locate ? projectSourceLine(body) : null;
  if (where) detail = `位置：${where}\n${detail}`;
  // 已列出失敗的測試時不再附輸出的錯誤行；只有 commit 說明時兩者都放。
  if (report)
    detail = report.startsWith("失敗的測試（")
      ? clip(report, 4000, "…（完整內容見執行紀錄）")
      : `${report}${detail ? `\n${detail}` : ""}`;
  return {
    category: rule.category,
    plain: rule.plain,
    action:
      typeof advice === "string"
        ? advice
        : advice(project ? `按「${validateLabel(project)}」` : "重新驗證環境"),
    group: rule.group,
    detail,
    ...(report && { groupDetail: clip(report, 1500, "…（完整內容見看板）") }),
  };
}

/** 看板摘要與管理者通知用：分類、白話說明、錯誤重點與建議處理，不含堆疊。 */
export function failureNotice(
  failure: FailureExplanation,
  retried = false,
  where = "",
) {
  const label = `${categoryLabels[failure.category]}${where ? `（${where}階段）` : ""}`;
  const again = retried ? "（已自動重試一次，仍然失敗）" : "";
  const detail = failure.detail
    ? `\n錯誤重點：${failure.detail}`
    : failure.category === "environment"
      ? "\n錯誤重點：工具沒有留下錯誤訊息，完整輸出見執行紀錄"
      : "";
  return `${label}：${failure.plain}${again}。${detail}\n建議：${failure.action}。`;
}

/**
 * 群組訊息：固定的白話句子，不放原始錯誤、堆疊或路徑；
 * 只附系統整理過、已遮蔽的內容（基底驗證失敗的測試清單與上次通過的 commit）。
 */
export function groupFailureText(failure: FailureExplanation, retried = false) {
  return `這則需求處理時遇到${categoryLabels[failure.category]}：${failure.plain}。${retried ? "系統已自動重試一次，仍未成功。" : ""}${failure.group}${failure.groupDetail ? `\n${failure.groupDetail}` : ""}`;
}
