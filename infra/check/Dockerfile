# 定期檢查映像（#19）：檢查容器（SQL Server 用戶端、HTTP／TCP 探測）與轉接器共用。
# 建置：docker build -f infra/check/Dockerfile -t line-agentflow-check:local .
# 只放打包後的兩支程式，不含原始碼樹、套件管理工具設定或任何機密。
FROM node:24-bookworm-slim AS build
WORKDIR /app
# 與服務映像相同的前兩層，可以共用建置快取。
COPY package*.json ./
RUN npm ci
COPY server ./server
COPY shared ./shared
RUN npx esbuild server/check-agent.ts server/check-forwarder.ts \
  --bundle --platform=node --format=cjs --target=node24 \
  --external:cpu-features "--external:*.node" \
  --outdir=/out --out-extension:.js=.cjs \
  && mv /out/check-agent.cjs /out/agent.cjs \
  && mv /out/check-forwarder.cjs /out/forwarder.cjs

FROM node:24-bookworm-slim
COPY --from=build /out /opt/check
USER 1000:1000
# 改了 server/check-agent.ts、server/check-forwarder.ts 及其引用的程式或本檔時，同步提高這裡與 server/check-environments.ts 的 CHECK_REV。
# 映像標籤不能用 io.agentflow.check：容器會繼承映像標籤，那是檢查容器記錄所屬檢查的標籤。
LABEL io.agentflow.check-image="v1" io.agentflow.check-rev="2026-11-14.1"
CMD ["node", "/opt/check/agent.cjs"]
