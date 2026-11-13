FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends squid ca-certificates && rm -rf /var/lib/apt/lists/*
COPY squid.conf squid-ai.conf /etc/squid/
EXPOSE 3128
CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]
