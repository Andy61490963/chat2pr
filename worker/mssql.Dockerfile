# 隔離整合測試專用；不連既有資料庫、不掛載 Docker socket。
FROM mcr.microsoft.com/mssql/server@sha256:11927f5edc5122658e90b3a80ee36e8aef779310bf771415c1d89271859c73fd AS sql
FROM line-agentflow-worker:local
USER root
RUN apt-get update && apt-get install -y --no-install-recommends redis-server libnuma1 libsss-nss-idmap0 libldap-2.5-0 libodbc2 odbcinst libltdl7 libcap2-bin && rm -rf /var/lib/apt/lists/*
COPY --from=sql /opt/mssql /opt/mssql
COPY --from=sql /opt/mssql-tools18 /opt/mssql-tools18
COPY --from=sql /opt/microsoft /opt/microsoft
COPY --from=sql /etc/odbcinst.ini /etc/odbcinst.ini
# 執行時仍 cap-drop=ALL；移除上游執行檔能力需求，避免非 root 執行遭拒。
RUN (setcap -r /opt/mssql/bin/sqlservr || test -z "$(getcap /opt/mssql/bin/sqlservr)") && rm -rf /var/opt/mssql && ln -s /workspace/obj/agentflow-sql /var/opt/mssql
# 測試階段啟動本機 SQL Server、暫時把 LocalDB 連線導向它（見 docs/agents/project-environment.md）。
COPY --chmod=755 worker/mssql/sqlserver.mjs /opt/agentflow-sql/sqlserver.mjs
RUN ln -s /opt/agentflow-sql/sqlserver.mjs /usr/local/bin/agentflow-sqlserver
LABEL io.agentflow.sqlserver-helper="1"
USER 1000:1000
