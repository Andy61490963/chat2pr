# 可續跑的隔離驗收

每次驗收使用新的 `suiteId`，例如 `20261106-a`，對應 `AGENTFLOW_INSTANCE=verify-20261106-a`。正式服務固定為 `production`。工作容器、工作卷、基底卷、來源快取及代理網路全部依 instance 隔離；同一個 run ID 出現在兩套環境也不能互相取消或清理。

## 啟動邊界

1. 將驗收專用 `SECRETS_FILE` 與 `CODEX_SERVICE_HOME` 明確放在包含 `verify-<suiteId>` 路徑段的目錄。設定檔須有獨立、至少 32 字元的 `runnerSecret`；登入檔只能由可信 runner 讀取。`RUNNER_LISTEN_PORT` 與 `SUBSCRIPTION_BROKER_PORT` 分別供工作控制與可信訂閱代理使用，預設為 14312／14313；驗收 app 的 `RUNNER_URL` 對應前者。兩者及 app、資料庫、模型入口不可重複，也不可使用正式 4310／4311／4312／4313／5439。
2. 資料庫指定不同的 `*_test` 名稱及獨立埠。此 Compose 預設 15439；若已有驗收資料庫，建立另一個測試資料庫，不能覆蓋同一個案例的資料。`DATA_DIR`、機密、輸出與預覽埠也各自獨立。
3. 先確認 `instanceName()` 通過且 `/health` 回傳預期 instance 及 `subscriptionBroker: "v1"`，再送工作。啟動器只在明確連線遭拒時新開 runner；已占用的舊協定程序、逾時或未知回應會報錯，不能因續跑而啟動清理。驗收 runner 在讀 Docker 或啟動清理以前，會拒絕缺少專用憑證目錄或使用正式埠的設定。
4. `compose.yaml` 提供專用代理、資料庫與可選的模型容器。`ACCEPTANCE_MODEL_VOLUME` 只能當唯讀權重來源；模型故障注入只停止此 Compose 的 `embedder`。禁止停止正式模型、runner、app、共用資料庫，禁止用全域 `io.agentflow.managed=true` 篩選後刪除。

`setup.ts` 可完成以上設定及啟動，需先明確提供 `ACCEPTANCE_AUTH_SOURCE`（可信登入檔）、`ACCEPTANCE_MODEL_VOLUME`、`ACCEPTANCE_DB_NAME`、`ACCEPTANCE_SUBSCRIPTION_RELAY_IMAGE` 與 instance。它會先檢查所有埠及轉送映像的 `io.agentflow.subscription-relay=v1` 標記，將映像解析成不可變 ID，通過後才複製登入到專用受限目錄並產生 runnerSecret；不啟動 Codex 推論。`runtime.json` 只輸出明列的設定鍵，絕不保存完整 `process.env`。在儲存庫根目錄先建立工具映像：

```powershell
docker build -f infra/source/Dockerfile -t line-agentflow-source:acceptance .
docker build -t line-agentflow-subscription-relay:acceptance infra/subscription-relay
$env:ACCEPTANCE_SUBSCRIPTION_RELAY_IMAGE = 'line-agentflow-subscription-relay:acceptance'
```

啟動器會讓 `ACCEPTANCE_SUBSCRIPTION_BROKER_PORT` 與 `SUBSCRIPTION_BROKER_PORT` 一致；若手動指定不同值則拒絕啟動。容器固定經 `http://subscription-relay:4313` 轉送至該 instance 的代理埠，僅持有工作階段的有限推論能力，不取得主登入檔。模型的主機入口另經專用 model relay，只接受固定 `/health` 與 `/embed`；embedder 本身仍只在 internal 網路，沒有對外連線。

正式環境保留舊工作卷與快取名稱。升級前沒有 instance 標記的工作容器及工作卷不自動認領、使用或刪除，應先對照資料庫 run ID 進行個別恢復／清理。只有帶 `io.agentflow.source-cache=v1` 的既有正式來源快取可沿用；它仍不會被 startup cleanup、cancel 或 dispose 刪除。

## Manifest 與 ledger

`ledger.ts` 匯出 `Manifest`、`AcceptanceLedger`。`AcceptanceLedger.open(root, manifest)` 建立 `root/verify-<suiteId>/manifest.json`，同 suiteId 的內容必須完全相同。案例識別碼如 `E01`、`E07.timeout` 不得重複；每案需記錄預期結果、環境（`isolated`／`line-live`）及證據種類（固定測試、真實模型、真實 LINE、瀏覽器）。

```ts
const ledger = await AcceptanceLedger.open(outputRoot, manifest);
await ledger.append({ caseId: "ISO-01", attempt: 1, status: "started" });
await ledger.append({
  caseId: "ISO-01",
  attempt: 1,
  status: "checkpoint",
  references: { taskId, runId, pr: 3, headSha },
  detail: "已記錄遠端結果，後續中斷先依這些識別碼核對",
});
await ledger.append({
  caseId: "ISO-01",
  attempt: 1,
  status: "failed",
  detail: "首次失敗原因",
});
// 修正後只能追加 attempt: 2，不能覆寫第一輪結果。
console.log(await ledger.summary());
```

每列以附加方式寫入、同步至磁碟，附帶 manifest hash、序號與時間；同時寫入被鎖定。中斷時保留 `started`／`checkpoint`，續跑前必須先核對本機 run、容器、遠端 Issue／PR，寫入 `reconciled` 和該輪結束結果，才能開始下一輪。鎖殘留、JSONL 末列不完整或 manifest 不一致都直接阻擋，不能靜默重放。`summary()` 同時回傳 `firstResult`、`firstFailure`、`latestResult`，明列修後成功，不能抹除第一輪失敗。

ledger 只能放識別碼、已遮蔽摘要與證據檔的路徑／SHA-256；不得放 API 金鑰、Cookie、完整授權標頭或 Codex 登入 JSON。圖片和來源原文仍由應用程式保留期限管理。

## 通過標準

- `tests/instance-isolation.test.ts` 用真 Docker 比對同 run ID 不同 instance 的工作卷、取消、清理與 heartbeat；無 instance 的舊哨兵也必須持續運作。
- `tests/source-cache.test.ts` 驗證冷快取、命中、增量、逾時及取消後仍可使用。快取不隨單次工作 dispose 刪除。
- `tests/acceptance-ledger.test.ts` 驗證不可覆寫首次失敗、不可重播未核對工作、manifest 防竄改與中斷寫入偵測。
- `verify-rag-flow.mjs` 明確採自動辨識，必須得到可解碼的實體 PNG；模型文字提及「截圖」不能算通過。該腳本只驗證圖片產物，畫面內容、手機／桌面與變更前後差異仍需瀏覽器驗收證據，不能混記為正式 LINE 成功。

執行 `node --import tsx scripts/acceptance/run-isolation.ts` 會以真 Docker 測試工作限制、快取與命名空間，將首次失敗、重跑結果和快取耗時附加到輸出目錄。設定 `ACCEPTANCE_SOURCE_IMAGE=line-agentflow-source:acceptance` 才會驗證剛建立的工具映像；修復後加 `--retry`。另以 `--boundaries` 執行簽章、1000筆訊息、預留額度、權限及供應商錯誤替身，必須指定15439上的獨立 `TEST_DATABASE_URL`。這些通過只涵蓋各子案例，不能當成全部E類、真LINE或真供應商故障驗收通過。

`--limits` 另外記錄301則對話／201個任務、5001個合格索引段落與20個同版核准的真資料庫競態。專案超過5000段時顯示 `limited` 與總數，停止同SHA自動重索引、不推論或發布半成品；新SHA可重新評估。分類器會看見缺索引原因，仍可處理已明確提供規格的新需求。既有恰5000段的舊索引在升級後撤下並重排核對，不能繼續宣稱完整。依賴目錄 `bower_components`、`vendors`、`.venv`、`venv` 不納入業務程式索引，5000上限未提高。

本輪已修正兩項實測問題：來源快取不再只信任 `snapshot-sha`，改核對快照樹、工作樹與Git物件，損壞時重建；API串流中斷不再把原始上游例外交給Fastify直接記錄，改保存固定安全診斷、結束串流並保守記帳。首輪腐損快取失敗與通知替身使用非法中文標頭的失敗皆保留在ledger，不因重跑成功而刪除。

`index-evidence.ts` 將48案與既有回歸、模型及ledger證據建立索引。`effort=low`只列探索，不能冒充正式`high`驗收；可指定 `ACCEPTANCE_REGRESSION_REPORT`、`ACCEPTANCE_MODEL_REPORT` 更新至後續報告。只有必要子項齊全才列整案通過，真LINE與D類畫面驗收要另外提供完整證據。
