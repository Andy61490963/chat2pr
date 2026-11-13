# 本機 RAG 任務清單

在需求判讀前加入本機向量檢索，讓 AI 能找回超過三天或不在最近 300 則內的相關對話、相似任務、記憶與程式檔案。全部在容器內執行，不使用外部 API、不消耗 Codex 訂閱額度。

依序完成四個階段；每個階段可獨立合併，後一階段依賴前一階段。各階段的追蹤 Issue：#9、#10、#11、#12。

## 共通規則（每個任務都適用）

- 遵守根目錄 `AGENTS.md`：文件、介面、commit 使用繁體中文；機密不得進入 Git、日誌或測試快照。
- 不新增主機程序：新服務一律放在 `compose.yaml`，主機上的執行器 `server/runner-main.ts` 不修改。
- **群組隔離**：檢索對話、任務、群組記憶時一定以 `group_id` 過濾；專案資料只限該群組已綁定的專案（`group_projects`）。
- **保存期限一致**：訊息的向量跟著原文到期（`server/maintenance.ts` 的 `cleanup`）與撤回（`server/line.ts` 處理 `unsend`）一起刪除；向量表不保存訊息原文，檢索時再從 `messages` 取文字。
- 向量為可重建的衍生資料，**不加入每日備份**（`server/maintenance.ts` 的 `backupTables`）。
- 向量服務只接內部網路；只有一次性的模型下載步驟可以連網。
- 測試不得依賴真實模型：以可注入的 `Embedder` 介面提供假向量（比照 `server/triage.ts` 的 `Classifier`）。
- 每個任務完成時：`npm run typecheck`、`npm test`、`npm run build` 全部通過，並更新 README 的架構與維運段落。

## 第 0 階段：基礎設施

追蹤：#9

### 0-1 資料庫改用 pgvector

- `compose.yaml` 的 `db` 與 `db-test` 映像改為 `pgvector/pgvector:pg17`（PostgreSQL 版本不變，沿用現有資料卷）。
- `server/schema.sql` 加入 `CREATE EXTENSION IF NOT EXISTS vector;` 與向量表：
  - `embeddings(id bigserial, kind text, ref_id text, group_id text NULL, project_id uuid NULL, sha text NULL, chunk int NOT NULL DEFAULT 0, path text NULL, content text NULL, embedding vector(1024) NOT NULL, created_at timestamptz DEFAULT now())`
  - `kind` 限定 `message`、`task`、`memory`、`knowledge`、`repo`、`outcome`。
  - 唯一鍵 `(kind, ref_id, chunk, COALESCE(sha,''))`；HNSW 索引 `vector_cosine_ops`；`(kind, group_id)`、`(kind, project_id, sha)` 一般索引。
  - `content` 只給 `repo` 與 `outcome` 使用，訊息類一律 NULL。

驗收：

- 既有資料庫升級映像後，看板資料完整、`npm run db:migrate` 可重複執行不出錯。
- `npm test` 在新的 `db-test` 上全部通過。
- `embeddings` 不在 `backupTables` 內。

### 0-2 本機向量模型服務

- 新增 compose 服務 `embedder`：Hugging Face `text-embeddings-inference` CPU 版映像（寫死版本號），模型 `BAAI/bge-m3`（1024 維）。
- 新增內部網路 `line-agentflow_embed`（`internal: true`），只有 `app` 與 `embedder` 加入。
- 模型放在資料卷 `embed-models`。新增一次性服務 `embedder-init`（profile `init`，可連網）負責下載；`embedder` 設定離線模式（`HF_HUB_OFFLINE=1`）並只掛唯讀資料卷。
- `app` 以環境變數 `EMBEDDER_URL` 取得服務位址。

驗收：

- 依 README 步驟執行 `docker compose --profile init run --rm embedder-init` 後，`docker compose --profile full up -d` 可啟動 `embedder`。
- 從 `embedder` 容器內連 `https://huggingface.co` 失敗；從 `app` 容器呼叫向量 API 成功並回傳 1024 維向量。
- `embedder` 停止時，`app` 其他功能（Webhook、看板、派工）不受影響。

### 0-3 向量介面、設定與健康檢查

- 新增 `server/embedder.ts`：`Embedder` 介面（`embed(texts: string[]): Promise<number[][]>`）、HTTP 實作（逾時 30 秒、分批）、測試用的假實作（同文字得到同向量）。
- 設定新增 `rag_enabled`（預設 `false`），看板「設定」的 AI 卡片加開關。
- `/api/integrations/check` 新增 `embedder` 檢查，看板「服務連線」顯示「本機向量模型」；`rag_enabled` 為否時不檢查。

驗收：

- 關閉 `rag_enabled` 時，系統行為與現在完全相同（既有測試全過）。
- 向量服務無法連線時，連線檢查顯示「需處理」並寫出原因。

## 第 1 階段：判讀時檢索對話、任務與記憶

追蹤：#10

### 1-1 建立與維護索引

- `server/jobs.ts` 新增佇列 `embed`：
  - 新訊息（文字）寫入後排程計算向量（不可阻塞 Webhook 回應）。
  - 任務建立或需求版本變更時，以「標題＋需求說明＋驗收條件」更新向量。
  - 群組記憶、專案記憶新增時建立向量，刪除時一併刪除。
- 新增一次性的「補建索引」工作：為既有資料建立向量，可在看板「設定」手動觸發，重複執行不重複寫入。
- 刪除規則：
  - 訊息到期（`cleanup`）與撤回（`unsend`）時刪除對應 `message` 向量。
  - 群組刪除或專案移除時，依外鍵或程式刪除相關向量。

驗收：

- 測試：收到訊息後佇列處理完成，`embeddings` 出現對應 `message` 列且 `content` 為 NULL。
- 測試：撤回訊息後該訊息的向量被刪除；訊息超過保存天數後向量被刪除。
- 測試：補建索引執行兩次，筆數不變。
- 向量服務暫時失敗時工作會重試，不會讓群組的需求辨識失敗。

### 1-2 判讀時檢索

- 在 `server/triage.ts` 的 `Triage.process`，呼叫分類器前：
  - 以本批訊息文字（含引用訊息）產生查詢向量。
  - 檢索同群組的舊訊息（排除已在 `recentConversation` 內的）最多 20 則、同群組任務最多 10 個、群組記憶最多 5 條、群組綁定專案的專案記憶最多 5 條。
  - 依相似度排序，並以時間遠近微調；總字數上限 20,000 字。
  - 放進 `context.retrieved`（訊息文字從 `messages` 即時讀取，已撤回或到期的不回傳）。
- 更新 `instructions`：說明 `context.retrieved` 是依相似度找回的舊資料，可能不相關，用來判斷是否為既有需求的補充、重複或新需求。
- 向量服務失敗或 `rag_enabled` 為否時，跳過檢索繼續判讀，並在服務健康狀態記錄原因。

驗收：

- 測試：兩個群組各有相似訊息時，A 群組判讀只會檢索到 A 群組的資料。
- 測試：撤回或到期的訊息不會出現在 `context.retrieved`。
- 測試：向量服務拋出錯誤時判讀仍成功完成，且未增加群組的判讀失敗次數。
- 實測：在群組提起超過三天前討論過的需求（例如「上週那個報表也要手機版」），判讀能關聯到原任務。

### 1-3 看板可觀察性

- 每次判讀寫一筆時間軸紀錄，例如「檢索到 4 則舊對話、2 個相關任務」，並記錄檢索到的任務編號。
- 任務詳情可展開「判讀時參考的資料」，列出檢索到的任務標題與舊訊息時間（不顯示已到期內容）。
- 「設定」顯示索引筆數（依種類）與最近一次補建索引時間。

驗收：

- 看板上可以看到某任務判讀時參考了哪些舊資料。
- 手機寬度（375px）下畫面正常、無水平捲動。

## 第 2 階段：專案檔案索引（專案路由與建議方案更準）

追蹤：#11

### 2-1 建立 repo 檔案索引

- 專案環境驗證成功時、以及判讀時發現基底 commit 與索引不同時，排程「專案索引」工作：
  - 在 `app` 容器以現有 GitHub App 權限下載封存檔（`server/github.ts` 的 `archive`），串流解壓。
  - 只收文字檔：`md`、`ts`、`tsx`、`js`、`jsx`、`cs`、`cshtml`、`py`、`html`、`css`、`sql`、`json`（小於 100 KB）等；排除 `node_modules`、`dist`、`bin`、`obj`、`.min.js`、鎖定檔、二進位與大於 200 KB 的檔案。
  - 依行切段，每段約 1,500 字、重疊 200 字，記錄路徑與起訖行號；每個專案上限 5,000 段。
  - 以 `(project_id, sha)` 區分版本；新版本完成後刪除舊版本。
- 看板「專案」卡片顯示索引狀態（索引中／已完成與段數／失敗原因）。

驗收：

- 約 4,000 個檔案、500 MB 的 example-org/test 可在 15 分鐘內完成索引，`app` 記憶體不超過 1 GB。
- 基底 commit 未變時不重建；變更後只保留新版本。
- 專案從所有群組移除或刪除時，索引一併刪除。

### 2-2 判讀時檢索檔案

- 判讀時對群組綁定的每個專案各取最相關的 3～5 段，放進 `context.projects[i].relevantFiles`（路徑、行號、內容），總字數另計上限 15,000 字。
- 更新 `instructions`：專案路由與三種建議方案要參考 `relevantFiles`，方案說明需寫出要修改的檔案路徑。

驗收：

- 測試：多專案群組中，訊息內容只與其中一個專案的檔案相關時，傳給分類器的 `relevantFiles` 主要來自該專案。
- 實測：在測試群組說「WIP 即時看板欄位太窄」，三種方案能指出 `Dashboard/WIP` 底下的實際檔案。

## 第 3 階段：從過去任務學經驗

追蹤：#12

### 3-1 任務結果索引與帶入開發

- 任務變成「待合併」、「需要處理」或「已合併」時，以「標題＋需求＋最後的審查意見或失敗原因＋是否合併」建立 `outcome` 向量（`content` 存這段摘要，`project_id` 為該專案）。
- `server/execution.ts` 開發與審查前，檢索同專案最相似的 3 筆結果，放進交給 Codex 的需求（例如 `pastOutcomes`），`worker/run.mjs` 的提示說明這些是過去經驗，僅供參考。

驗收：

- 測試：任務失敗後產生 `outcome` 向量；下一個同專案、相似的任務開發時，`pastOutcomes` 包含該筆。
- 測試：不同專案的結果不會互相帶入。
- 實測：曾因「截圖驗收」失敗的需求，再次出現類似需求時，Codex 的變更說明或審查會主動處理截圖。

## 交付順序建議

1. 第 0 階段合併後，先以 `rag_enabled = false` 部署，確認服務與連線檢查正常。
2. 第 1 階段合併後補建索引，再開啟 `rag_enabled`，觀察幾天判讀結果與看板上的「判讀時參考的資料」。
3. 一個群組綁多個專案、或專案路由常出錯時，再進行第 2 階段。
4. 累積一些任務結果後，進行第 3 階段。
