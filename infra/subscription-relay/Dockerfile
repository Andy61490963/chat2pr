FROM node:24-bookworm-slim
COPY server.mjs /relay.mjs
USER 1000:1000
LABEL io.agentflow.subscription-relay="v1"
CMD ["node", "/relay.mjs"]
