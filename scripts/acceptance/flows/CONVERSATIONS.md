# F03–F09 對話流程驗收

每案從新的隔離資料庫開始，透過簽章 LINE 訊息、登入後的管理 API 和背景工作推進。模型替身提供判讀、執行或審查的輸出。任務、需求版本、候選修改、PR 和通知均由實際服務產生。案例結束後，由主控檢查工作資源、通知、派工狀態與機密遮蔽，再把結果寫入帳本。

## 主控接法

```ts
import { conversationFlows, type ConversationNumber } from "./conversations.js";
import type { BasicFlowContext } from "./basic.js";
import { installModelSteps } from "./script-control.js";

// number 已由案例目錄限為 3 至 9，ctx 為本次 startFlowApplication 建立的內容。
async function run(number: ConversationNumber, ctx: BasicFlowContext) {
  return conversationFlows[number]({ ...ctx, setModelSteps: installModelSteps });
}
```

`BasicFlowContext` 由 `./basic.js` 匯出。每案自訂模型步驟，父程序收到 `script` 後須安裝整段步驟，再以 `script-ready` 回覆。每個劇本回傳實際群組收件文字與帳本可接受的 `taskId`、`runId` 等參照。F03 的主參照是第二個選取項目，兩張 PR 的網址都在群組收件文字中。F09 的主參照是子任務與追加後的 PR 提交。

**F08 另需接模型請求本文。** 上游收到 `POST /backend-api/codex/responses` 時，對有 `recentRejection` 的步驟，將當次步驟與已解析的 JSON 本文交給 `resolveConversationStep(step, body)`，用回傳值送出 SSE。IPC 須保留步驟上的 `recentRejection` 欄位。解析器只核對本則新訊息、觸發方式及 `context.recentRejections` 中的標題、摘要與拒絕原因。若上游直接使用固定的 `step.text`，第二則訊息會建立任務，F08 會報「相似訊息仍建了任務」。請求本文僅供程序內比對。

開發時以本機的 `startModelService(false)` 送入帶有正確拒絕紀錄的判讀本文。服務收到一個請求並回 HTTP 200，解析器的結果為 `ignore`，當時串流的 `response.output_text.done` 卻為 `request`。`npx vitest run tests/acceptance-conversations.test.ts -t "F08 模型服務"` 可單獨重跑這個接點，也會檢查移除拒絕紀錄後是否回到 `request`。

## 各案完成條件與卡點

| 案例 | 完成證據 | 中途停止時核對 |
| --- | --- | --- |
| F03 清單挑選 | 一則會議紀錄先出現三個待辦。從看板挑東門、排隊兩項，兩者各自核准、執行、測試、審查到 `ready`。兩張 PR 內容及群組回覆分別對應自己的項目。 | 挑選前，來源對應的任務數應為零。挑選後清單關閉，來源對應恰好兩張任務。若只完成一項，第二項的 `ready` 通知或 PR 會缺失。 |
| F04 引用追問 | 群組先收到 5 張的回答，再引用該則回答提出追問。新題的 `parent_id` 指向原題，答案為 9 張，原回答及版本均保留。 | `group_answered` 需有已送達的 `sent_message_id`。缺少識別碼時會停在取得 LINE 訊息識別碼，無法送出有效引用。 |
| F05 回答執行中的補問 | 第一次查詢執行提出補問，停在 `awaiting_approval`。群組成員引用機器人問題回答，原任務換版，第二次執行回答 8 張。 | 檢查看板的 `input_required` 通知、已送達的 `group_question` 與問題文字。引用成功後應有 `question_answered` 稽核，新版摘要及來源須包含答案。 |
| F06 敏感候選 | 第一次核准後修改 `infra/venue.md`。實際路徑觸發再審，核對保存的位元組與可接續版本後再次核准。第二次執行沿用候選，通過測試、審查並發布相同內容。 | 第一次執行清理後應有 `pending_paths`、`risk` 通知、`runs.result.files` 及 `candidate.resumeVersion`。若恢復後重新進入 `code` 階段，或 PR 檔案不同，便會失敗。 |
| F07 指定專案 | 查詢停在未指定專案，管理者以 `assign` 選擇群組已綁定的專案，再依新版專案、分支及綁定版本核准。群組與看板都收到 7 張的答案。 | 第一次待確認時專案及分支皆應為空，還沒有執行。指定後須讀回新版；最終稽核應依序出現 `assign`、`approve`、`started`、`answered`。 |
| F08 拒絕後略過相似訊息 | 管理者以「不是給 AI 的工作」拒絕，群組收到結束通知。第二則同群組訊息經自動判讀，稽核指出與近期拒絕需求相似，資料庫只留下第一張被拒絕的任務。 | 檢查上述模型上游接點。須先等第二則訊息的 `processed` 與 `batch_id`，才能據任務數判定結果；單純等一段時間無法證明判讀已執行。 |
| F09 增量子任務 | 父項目先發布 PR。引用原通知追加排隊說明後，子任務只含追加來源、摘要及驗收。獨立核准後，子任務從父 PR 的 head 執行修改、測試與審查，在同一 PR 產生新提交，保留父檔並新增子檔。最後投遞簽章合併事件，父子兩張任務均須到 `merged`，群組各收到合併通知。 | 等待子任務核准是中繼狀態。若父 PR 已經關閉、head 不在同一儲存庫或分支不符，會失去追加條件。比較子任務的 `base_sha` 與父 PR 的原 head，再檢查 PR 編號、子 Issue、新 head 和兩份檔案內容。 |

## 執行與證據範圍

輕量檢查可執行 `npx vitest run tests/acceptance-conversations.test.ts --maxWorkers=1`。它驗證七案的簽章輸入與入口拒收、拒絕原因有無傳入模型，以及各案關鍵證據的正反例。

主控接線後，F03、F04、F05、F06、F07、F09 均使用既有隔離 app、PostgreSQL、jobs、訂閱 broker／relay、工作容器與聊天、GitHub 替身。F08 另外依賴模型本文解析。完整實跑要有重型工作排隊時段，並設定本輪專用的 `ACCEPTANCE_OUTPUT_ROOT`。單案指令為 `npm run acceptance:flows -- 9`，將數字替換為欲驗收的案例。本次開發只執行輕量檢查；七案的實跑狀態以各自隔離驗收帳本為準。
