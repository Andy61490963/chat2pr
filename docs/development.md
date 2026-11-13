# 開發與驗證

參與開發前請先讀 [專案慣例與注意事項](conventions.md)，裡面列了哪些檔案要一起改、哪些指令不能在哪裡執行。

## 原始碼結構

| 目錄       | 內容                                                                                                                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/`  | 應用程式（Fastify）：Webhook、管理 API、需求判讀（`triage.ts`）、派工與執行（`execution.ts`）、背景工作（`jobs.ts`）、GitHub 串接（`github.ts`），以及主機執行器（`runner-main.ts`、`containers.ts`）。資料表在 `schema.sql`，`app` 啟動時自動遷移。 |
| `shared/`  | 伺服器與看板共用的型別與純函式。                                                                                                                                                                                                                     |
| `src/`     | 看板（React 19 + Vite + shadcn/ui）。頁面在 `src/app/`，共用元件在 `src/components/`。                                                                                                                                                               |
| `worker/`  | 工作容器映像與在容器內執行的腳本（Codex SDK 開發、審查、判讀、差異收集）。                                                                                                                                                                           |
| `infra/`   | 其他容器：出口代理（`egress`）、訂閱推論轉送（`subscription-relay`）、原始碼快取工具（`source`）。                                                                                                                                                   |
| `scripts/` | 部署（`deploy.mjs`）、初始化、備份還原、開機啟動、通道與各種驗收腳本。                                                                                                                                                                               |
| `tests/`   | vitest 測試；`helpers.ts` 提供測試資料庫與固定資料。                                                                                                                                                                                                 |
| `docs/`    | 文件。`specs/` 是歷史規格，`records/` 是驗收與量測紀錄。                                                                                                                                                                                             |

架構與資料流見 [架構](architecture.md)。

## 開發環境

開發一律在部署目錄以外的 clone 或 `git worktree` 進行：

```powershell
git worktree add ..\chat2pr-dev -b 分支名稱 origin/main
cd ..\chat2pr-dev
npm ci
```

需要 Node.js 24 與 Docker Desktop（Linux 容器）。

## 自動測試

```powershell
docker compose --profile full --profile test up -d --build --wait db-test egress
npm run typecheck
npm test
npm run build
```

開發目錄和正式服務在同一台主機時，**略過第一行**：測試資料庫 `db-test` 已經在執行，而 Compose 專案名稱是固定的，從開發目錄執行 `docker compose up` 會動到正式容器。

測試使用獨立的 `agentflow_test` 資料庫（只在本機 `5439` 開放）與真實 Docker 容器，不需要真實 API 金鑰。部分測試會實際建立工作容器；需要新工作映像時見 [慣例第 4 節](conventions.md#4-測試)。

CI（`.github/workflows/`）在每個 PR 執行同樣的檢查。

## 交付流程

1. 在 GitHub Issue 寫規格（繁體中文）。
2. 在開發目錄開分支實作，修改後執行 `npm run typecheck` 與相關測試。
3. 交付前執行 `npm test`、`npm run build`。
4. 開 PR 關聯 Issue，說明分「改了什麼」「驗證」「待人工確認」。
5. CI 通過後以合併提交合併，標題「合併 #N：…」。
6. 在部署目錄執行 `npm run deploy`（見 [部署手冊的〈升級〉](deployment.md#升級)）。

## 真實服務驗收

自動測試不能取代真實 LINE、真實模型與實際瀏覽器的驗收。上線前的清單見 [真實服務驗收清單與紀錄](records/real-service-acceptance.md)。

### 本機重播完整流程（訂閱模式）

建立專用的空白 PostgreSQL 資料庫（名稱以 `_flow_test` 結尾），將 `DATABASE_URL` 指到該庫。準備只含虛構 `lineSecret`、`githubWebhookSecret` 的測試設定檔，將 `SECRETS_FILE` 指到它。`RAG_VERIFY_RUNNER_CONFIG` 指向主機已受保護的執行器設定，僅讀取執行器金鑰。主機須已登入訂閱並啟動執行器、模型與出口代理；設定 `RAG_VERIFY_APP` 為可連到模型的 app 容器名稱。

從目前 checkout 執行 `docker build -f worker/Dockerfile -t line-agentflow-worker:rag-verify .`，設定 `RAG_VERIFY_WORKER=line-agentflow-worker:rag-verify` 後執行 `node --import tsx scripts/verify-rag-flow.mjs`。驗收會使用訂閱額度。腳本透過簽章 Webhook 重播需求，等待實際背景佇列、模型、程式修改、測試與獨立審查，最後核對合併事件回寫的結果。GitHub 發布使用隔離替身，保留待檢查的資料只在指定測試庫中。每次重跑使用新的空白測試庫，完成後可移除該庫。

### 執行紀錄監看驗收

`scripts/verify-observer.mjs` 使用真實 Codex 修改與審查，GitHub 發布與 LINE 通知留在隔離替身，不對正式專案發文。需要：

- 空白的 `*_observer_test` 資料庫；
- 獨立埠的執行器（`RUNNER_LISTEN_PORT`）；
- 僅含測試 `runnerSecret` 的 `SECRETS_FILE`；
- 服務專用的 `CODEX_SERVICE_HOME`；
- `line-agentflow-worker:observer` 工作映像。

設定 `DATABASE_URL` 與 `RUNNER_URL` 後執行 `node --import tsx scripts/verify-observer.mjs`，報告寫入 `.local/observer-proof.json`。驗收必須設定 `AGENTFLOW_INSTANCE=verify-<suiteId>`，使用專用設定檔、登入目錄、網路與非正式埠。啟動清理只處理相同 instance；未標記 instance 的舊資源保留，不自動認領。真實 Codex 驗收與正式開發仍須序列執行。

### 可續跑的全流程驗收

完整案例與證據門檻見 [全流程驗收規格](specs/full-flow-acceptance.md)。`scripts/acceptance/ledger.ts` 將固定案例 manifest 與結果追加寫入；中斷須先核對既有任務／PR，不能覆寫首次失敗或把重試後成功當成首次成功。真實 LINE、隔離重播、真實模型、服務替身與實際瀏覽器必須逐層標示。驗收用的測試儲存庫以環境變數 `ACCEPTANCE_REPO` 指定（格式 `擁有者/儲存庫`）。

`scripts/acceptance/setup.ts` 建立專用資料庫、模型入口、代理及主機 runner。設定 `AGENTFLOW_INSTANCE=verify-<suiteId>`、`ACCEPTANCE_DB_NAME=<名稱>_test`、`ACCEPTANCE_MODEL_VOLUME=<現有模型卷>`、`ACCEPTANCE_AUTH_SOURCE=<服務專用 auth.json 絕對路徑>`，並依[隔離驗收說明](../scripts/acceptance/README.md)建置與指定 `ACCEPTANCE_SUBSCRIPTION_RELAY_IMAGE`，再以 `node --import tsx scripts/acceptance/setup.ts` 啟動。預設本機埠為 runner 14312、訂閱代理 14313、看板 14310、資料庫 15440、模型 18080；可用對應環境變數修改，彼此不得重複或占用正式埠。模型只讀載入既有模型卷並維持隔離內網，主機經只開放 `/health` 與 `/embed` 的專用轉送服務存取。續跑只接受相同 instance 且健康回應含 `subscriptionBroker: "v1"` 的 runner；舊版程序、逾時或不明回應會明確停止啟動流程，不自動清理既有工作。

快取命中會核對快照的 Git 樹、工作檔案及物件完整性；損壞時從現有 Git 物件重建，不能只相信 SHA 標記。升級前的快照首次需重建一次，準備時間應重新量測，不沿用舊版效能數字作為新版保證。

## 歷史規格

- [第一版規格](specs/spec.md)：領域規則與各階段功能的原始需求。
- [本機 RAG 任務清單](specs/rag-tasks.md)
- [全流程驗收規格](specs/full-flow-acceptance.md)
