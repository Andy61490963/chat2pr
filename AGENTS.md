# 專案工作規則

- 所有文件、使用者介面、Issue、PR 與 commit 訊息使用繁體中文。
- commit 與 PR 標題用 Conventional Commits 格式：`類型: 說明`（類型英文小寫，例如 `feat`、`fix`、`docs`；說明用繁體中文）。PR 以 Squash and merge 合併；說明寫 `Closes #N`。細節見 `docs/conventions.md` 第 1 節。
- 機密不得加入 Git、日誌、測試快照或聊天；測試使用虛構憑證。
- 不可繞過登入、風險審核、預算、版本檢查或容器隔離。
- 以使用者可觀察的介面測試：Webhook、管理 API、工作狀態、外部服務介面及容器權限。
- 部署目錄（有 `.local/secrets.json` 的那一份）只用 `npm run deploy` 更新；開發一律在另一份 clone 或 `git worktree` 進行，不在部署目錄切分支或改檔，也不在開發目錄執行 `docker compose up`（會動到正式容器）。
- 修改後執行 `npm run typecheck`、相關測試；交付前執行 `npm test`、`npm run build`。
- 動手前先讀 `docs/conventions.md`（哪些檔案要一起改、哪些指令不能在哪裡執行）；發現新的潛規則就補進去並寫明原因。
- 文件與測試只用虛構的專案、群組與帳號名稱，不放真實客戶資訊。

## Agent skills

### 任務追蹤

規格及開發任務使用本儲存庫 GitHub Issues，規則見 `docs/agents/issue-tracker.md`。

### 領域文件

採單一領域，探索前閱讀 `CONTEXT.md` 與相關架構決策；規則見 `docs/agents/domain.md`。
