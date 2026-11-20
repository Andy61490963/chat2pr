# 任務追蹤：GitHub

正式來源為本儲存庫的 GitHub Issues。查詢與更新一律用本機已登入的 `gh`（儲存庫擁有者的帳號）；建立 Issue、留言、開 PR 不使用 AI 工具內建的 GitHub 連線。動手前先跑 `gh auth status` 確認登入的是擁有者帳號，不是就停下來回報。不在標題、內容或附件放入金鑰。

原因：AI 工具的 GitHub 連線可能綁定借用帳號的 GitHub 身分。曾有 Issue 因此以他人名義建立，GitHub 自動讓作者訂閱，之後每次推送、合併、關閉都寄信到對方信箱，而且只有對方本人能取消訂閱。

規格以 Issue 保存，實作 PR 關聯 Issue。所有標題、說明與 commit 訊息使用繁體中文；commit 與 PR 標題加 Conventional Commits 類型前綴（`feat:`、`fix:`、`docs:` 等），PR 說明用 `Closes #N` 關閉對應 Issue。PR 預設不作為外部需求的自動收件來源。

產品執行時產生的需求 Issue 建立於群組綁定的目標儲存庫，與本產品研發 Issue 分開。
