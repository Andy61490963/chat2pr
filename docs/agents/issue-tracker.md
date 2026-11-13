# 任務追蹤：GitHub

正式來源為本儲存庫的 GitHub Issues。使用已連線的 GitHub 工具或 `gh` 查詢與更新；不在標題、內容或附件放入金鑰。

規格以 Issue 保存，實作 PR 關聯 Issue。所有標題、說明與 commit 訊息使用繁體中文；commit 與 PR 標題加 Conventional Commits 類型前綴（`feat:`、`fix:`、`docs:` 等），PR 說明用 `Closes #N` 關閉對應 Issue。PR 預設不作為外部需求的自動收件來源。

產品執行時產生的需求 Issue 建立於群組綁定的目標儲存庫，與本產品研發 Issue 分開。
