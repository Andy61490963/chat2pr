# .NET 8 SDK 取自官方映像（同為 Debian bookworm），固定版本與 C# 專案的 global.json 對齊。
FROM mcr.microsoft.com/dotnet/sdk:8.0.416-bookworm-slim AS dotnet
FROM node:24-bookworm-slim
# 開發階段不能連外下載，Codex 需要的工具必須預先裝在映像內。
# libusb：pyrealsense2 等硬體套件；fonts-noto-cjk：中文頁面截圖不會變方塊字；
# ripgrep：Codex 搜尋程式碼的首選工具；jq、sqlite3、unzip：常見資料處理。
# libicu72：.NET 的中文文化與時區格式。
# openssh-client、sshpass：完全存取的專案用 agentflow-ssh 登入管理者登記的 SSH 主機。
# iputils-ping、netcat-openbsd：診斷內網主機及 TCP 連接埠。
# 用 install 重建 ping 檔案，移除套件可能設定的檔案能力與 setuid，讓它以 ICMP datagram socket 執行。
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 python3-venv python3-pip libusb-1.0-0 make g++ fonts-noto-cjk ripgrep jq sqlite3 unzip libicu72 openssh-client sshpass iputils-ping netcat-openbsd \
    && install -m 0755 /usr/bin/ping /usr/bin/ping.unprivileged \
    && mv /usr/bin/ping.unprivileged /usr/bin/ping \
    && rm -rf /var/lib/apt/lists/*
# .NET 8 SDK：C# 專案可在容器內建置與執行單元測試。
# NuGet 套件於安裝階段經 egress 下載到 /workspace/obj/nuget；.NET 專案慣例忽略 obj/，
# 因此跨階段保留又不會被當成變更。
COPY --from=dotnet /usr/share/dotnet /usr/share/dotnet
RUN ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet
ENV DOTNET_ROOT=/usr/share/dotnet DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 DOTNET_CLI_HOME=/tmp/home NUGET_PACKAGES=/workspace/obj/nuget
WORKDIR /opt/agentflow
RUN npm init -y && npm install --save-exact @openai/codex-sdk@0.166.0
# 無頭 Chromium 與 Playwright：前端需求可截圖驗收，審查員也能檢視截圖。
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright NODE_PATH=/usr/local/lib/node_modules
RUN npm install -g --save-exact playwright@1.52.0 && playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/* /root/.npm && chmod -R a+rX /opt/ms-playwright
COPY worker/*.mjs ./
RUN chmod 755 /opt/agentflow/agentflow-ssh.mjs && ln -s /opt/agentflow/agentflow-ssh.mjs /usr/local/bin/agentflow-ssh
# worker-rev：worker/*.mjs 或工具鏈有變更時更新，並同步 server/containers.ts 的 WORKER_REV；
# 執行器會拒絕較舊的映像，避免專案默默使用舊的工作程式。
LABEL io.agentflow.worker="v1" io.agentflow.worker-rev="2026-11-21.1"
USER 1000:1000
WORKDIR /workspace
ENV HOME=/tmp/home
CMD ["node", "/opt/agentflow/run.mjs"]
