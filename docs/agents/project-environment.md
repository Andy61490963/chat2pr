# 自動準備專案測試環境

AI 先讀取固定版本的專案說明、建置設定及 `scripts`／`tests/environment` 下的準備腳本，再使用執行器實際探測的工具清單選擇命令。原始碼與測試斷言不可為了通過驗證而改寫；測試範圍只有在缺少真實資料或外部服務時才可以縮小，而且必須標示為部分測試並說明排除了什麼。

建置設定優先於 README。長篇 README 先完整檢查是否含機密，再擷取安裝、測試與環境附近的原文，並向 AI 標明省略內容。每份摘錄最多 24,000 位元組，所有檔案內容合計最多 100,000 位元組；單份 README 超過 256,000 位元組或累計讀取超過 1,000,000 位元組時，不下載該文件，依其他設定判讀。實際建置設定仍維持原有大小限制，不將不完整設定當成完整依據。

環境驗證會實際執行安裝與測試；失敗時將遮蔽後的診斷交回 AI，最多再調整兩次。API 模式的三次判讀共用一次預留額度，設定版本變更即停止。完成後仍比對追蹤檔案，測試成功且沒有留下來源變更才保存設定並啟用。

只在缺少使用者持有的資料、權限或必要選擇時補問。畫面先顯示一句白話原因與下一個必要問題，技術診斷放在可展開區塊。登入與驗證碼由使用者在服務本身完成，不存入專案資訊。等待回答時清理工作資源，回覆後重新驗證。

## SQL Server 與 Redis 測試映像

`docker build -f worker/mssql.Dockerfile -t line-agentflow-worker-mssql:local .` 可建置含 SQL Server Developer、Redis 的衍生工作映像。部署流程會更新已存在的這個映像；沒有啟用時不額外建置。

### 自動選用與 LocalDB 導向

AI 自動設定的專案不必手動選這個映像。系統從固定版本的專案檔、套件設定與 CI 判斷測試是否需要 SQL Server（`server/sqlserver-test.ts` 的 `detectSqlServer`）：

- 測試專案（引用 `Microsoft.NET.Test.Sdk`、xUnit、NUnit、MSTest 或標記 `IsTestProject`）本身或它參照的專案使用 `Microsoft.Data.SqlClient`、`System.Data.SqlClient`、`Microsoft.EntityFrameworkCore.SqlServer`。
- CI 準備 SQL Server 服務（`mcr.microsoft.com/mssql/server`）或 LocalDB（`sqllocaldb`、`(localdb)\MSSQLLocalDB`）。

判斷需要、而且專案的工作容器映像是預設的 `line-agentflow-worker:local` 時，安裝、測試、開發與審查都改用 `line-agentflow-worker-mssql:local`；判斷依據寫在環境設定說明的開頭，專案詳情看得到。專案的「工作容器映像」欄位不會被改寫。不需要 SQL Server 的專案維持較小的預設映像。

管理者可在專案的「進階設定 → 測試用 SQL Server」覆寫：「自動判斷」（預設）、「一律提供」、「不提供」。工作容器映像填自訂映像時不自動更換；選「一律提供」時照用自訂映像，該映像必須含 `agentflow-sqlserver`。

需要 SQL Server 時，系統把 AI 規劃的測試命令包在 `agentflow-sqlserver run -- sh -c '<測試命令>'` 裡執行（`worker/mssql/sqlserver.mjs`，裝在衍生映像的 `/usr/local/bin/agentflow-sqlserver`）：

1. 在同一個測試容器啟動 SQL Server（`127.0.0.1,1433`，記憶體上限 1 GiB，最多等 150 秒；第一次失敗會清掉資料檔重試一次）。sa 密碼每次隨機產生，只放在這個容器的環境變數 `MSSQL_SA_PASSWORD`、`SQLCMDPASSWORD`、`AGENTFLOW_SQLSERVER_CONNECTION`。
2. 掃描工作目錄中的文字檔（`.cs`、`.json`、`.config`、`.runsettings` 等，略過 `bin`、`obj`、`node_modules`、`.git`），把 LocalDB 連線（`(localdb)\執行個體`）改成連到容器內 SQL Server 的 sa 帳號，Windows 整合驗證改為關閉；`AttachDbFilename` 改用同名資料庫。改寫前先把原檔備份到 `/workspace/obj/agentflow-sqlserver`。
3. 建立連線字串提到的空白資料庫；規劃的資料來源是結構快照時，再依序套用 `schema.sql`、`reference-data.sql`。沒有快照時由專案自己的遷移或建庫腳本建立資料表（在測試命令中執行）。
4. 執行測試命令，結束後把檔案還原成原本的位元組、停止 SQL Server、刪除資料檔。上一次在測試途中被強制結束時，下一次執行會先還原。

導向只發生在測試容器內，不修改專案的版本控制檔案；之後的收集階段仍會確認沒有變更。測試容器維持無網路、非 root、唯讀根目錄。Codex 在開發階段自行測試時也被告知用同一個指令。

SQL Server 起不來或建庫失敗時，測試命令不會執行，`agentflow-sqlserver` 以退出碼 86 結束並輸出 `AGENTFLOW_TEST_ENVIRONMENT {"ok":false,...}`。系統把這種結果標示為「測試環境問題（不是程式沒過）」，列出被跳過的測試命令與判斷依據；環境驗證不交給 AI 改命令重試，派工也不交給 Codex 修程式。

更新 `worker/mssql/sqlserver.mjs` 後要重建衍生映像。主機還沒有 `line-agentflow-worker-mssql:local` 時，判斷需要 SQL Server 的專案會在驗證時明確提示建置指令；若不想建置，改為「不提供」。

驗收測試（需要先建好含 `agentflow-sqlserver` 的映像，約一分鐘）：

```bash
ACCEPTANCE_MSSQL_IMAGE=<臨時標籤> npx vitest run tests/acceptance-sqlserver.test.ts
```

它用虛構的 C# 專案（`tests/fixtures/localdb-project`，整合測試寫死 LocalDB）確認：不導向時失敗、導向後在無網路容器內實際連上 SQL Server 並通過、結束後追蹤檔案不變；以及 SQL Server 沒有就緒時標示為測試環境問題。

其他服務（例如 Redis），或沒有由系統提供 SQL Server 時，專案測試腳本需在同一個測試階段啟動本機服務，使用虛構資料與臨時憑證，設定啟動期限並在結束時清理。安裝階段與測試階段的程序不共用。測試容器仍使用無網路、非 root、唯讀根目錄、能力全移除、2 GiB 記憶體與程序數限制，不連正式資料庫、不提供 Docker socket。

SQL Server 工具來自固定摘要的官方映像；這是測試用組合環境，不是正式資料庫的部署配置。專案沒有可重現的結構時，使用擁有者在專案詳情擷取的結構快照（唯讀掛載在 `/agentflow/env/database`，先讀其中的 `README.md`）；沒有快照時由 AI 從程式碼推測結構。資料庫與測試資料的缺口不補問，詳見[專案環境自動設定](../project-setup.md)的〈資料庫連線與結構快照〉。

容器內的 SQL Server 需要兩百多個程序；工作容器的程序數上限是 512。用 sqlcmd 套用快照時不要加 `-b`，讓個別物件失敗時仍繼續套用其餘批次。
