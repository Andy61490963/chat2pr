FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates util-linux && rm -rf /var/lib/apt/lists/*
LABEL io.agentflow.source="v1"
COPY infra/source/prepare.mjs /opt/agentflow/prepare.mjs
COPY infra/source/askpass.sh /opt/agentflow/askpass.sh
RUN chmod 755 /opt/agentflow/askpass.sh
ENTRYPOINT ["flock", "-x", "/cache/lock", "node", "/opt/agentflow/prepare.mjs"]
