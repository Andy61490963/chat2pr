# PostgreSQL 17 資料卷升級與復原

適用於從 `postgres:17-alpine` 遷移到 `pgvector/pgvector:pg17` 的既有安裝。兩者都是 PostgreSQL 17，但 Alpine 與 Debian 的文字排序實作不同。請在維護時段執行；先在隔離副本演練以下步驟。

1. 在看板暫停派工、等待執行中任務結束，記錄群組、專案及任務數量與目前版本。停用並結束 Windows 的 `LINE-AgentFlow` 排程工作，停止應用與執行器的寫入。在此之前保留舊 checkout、資料庫與應用映像。
2. 用舊映像停止資料庫後，完整複製 **database 資料卷** 到新的私有 Docker 卷，保留檔案權限。用另一份副本以舊映像、無外網與無應用連線啟動，執行唯讀查詢驗證可還原。此份備份含原始資料，只限維護者存取，在維護完成後依原文保存期限清理。日常加密備份只含部分資料表，不適合作為切換快照。
3. 保留快照，再更新 checkout。只啟動 `docker compose up -d --wait db`，確認掛載同一個正式資料卷。先跑 `docker compose exec -T db reindexdb -U agentflow --all`。若遇到唯一鍵衝突或索引重建失敗，停止切換。
4. 透過 `psql` 檢查 `SELECT datname, datcollversion, pg_database_collation_actual_version(oid) FROM pg_database`。對有記錄舊版本且版本已變動的資料庫，在重建索引後執行 `ALTER DATABASE 資料庫名稱 REFRESH COLLATION VERSION`。此主機從 Alpine 延用的舊資料庫版本欄位是 NULL，PostgreSQL 17 會拒絕用 REFRESH 從 NULL 改成版本字串。保留 NULL，記錄目前 glibc 版本，之後變更排序實作時再次重建索引。用 `pg_amcheck -U agentflow -d agentflow --install-missing --heapallindexed --parent-check` 檢查既有 B-tree 與資料表。
5. 執行 `docker compose build app`，再執行兩次 `docker compose run --rm --no-deps app npm run db:migrate`。比對群組、專案、任務、設定與索引，確認 `rag_enabled=false`。依 README 初始化模型並啟動 full 服務，驗證看板、Webhook 與派工連線後才恢復排程與原有派工設定。
6. 若任一步驟失敗，在重新接受寫入前停下新服務，還原舊 checkout 和映像，把已驗證的完整備份複製到獨立復原卷，以該卷作為 Compose 的 `database` 卷重新啟動。保留切換失敗的卷供核對，避免在兩個版本間直接來回掛載已變更的資料卷。
