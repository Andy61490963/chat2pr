import http from "node:http";
const targetPort = Number(process.env.BROKER_PORT ?? 4313);
if (
  !Number.isInteger(targetPort) ||
  targetPort < 1024 ||
  targetPort > 65535 ||
  targetPort === 4312
)
  throw new Error("訂閱代理連接埠無效");
const route = /^\/v1\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/responses$/;
const server = http.createServer((req, res) => {
  const fail = (status) => {
    if (!res.headersSent)
      res.writeHead(status, { "Content-Type": "application/json" });
    res.end('{"error":{"message":"訂閱轉送失敗，未使用其他計費方式"}}');
  };
  if (
    req.method !== "POST" ||
    !route.test(req.url ?? "") ||
    req.headers["content-type"]?.split(";")[0] !== "application/json" ||
    !/^Bearer [a-f0-9]{64}$/.test(req.headers.authorization ?? "")
  )
    return fail(403);
  // 目的地主機、路徑種類與方法固定；不轉送 Cookie、Host 或任意代理標頭。
  const upstream = http.request(
    {
      hostname: "host.docker.internal",
      port: targetPort,
      method: "POST",
      path: req.url,
      headers: {
        "Content-Type": "application/json",
        Authorization: req.headers.authorization,
      },
    },
    (reply) => {
      if (reply.statusCode !== 200) {
        reply.resume();
        return fail(
          [401, 403, 408, 429].includes(reply.statusCode)
            ? reply.statusCode
            : 502,
        );
      }
      if (!reply.headers["content-type"]?.includes("text/event-stream")) {
        reply.resume();
        return fail(502);
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      });
      reply.pipe(res);
      reply.on("error", () => res.destroy());
    },
  );
  const timer = setTimeout(() => upstream.destroy(), 30 * 60 * 1000);
  let bytes = 0;
  req.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 48 * 1024 * 1024) {
      upstream.destroy();
      fail(413);
    } else upstream.write(chunk);
  });
  req.on("end", () => upstream.end());
  req.on("aborted", () => upstream.destroy());
  upstream.on("error", () => fail(502));
  res.on("close", () => {
    clearTimeout(timer);
    upstream.destroy();
    if (!req.complete) req.destroy();
  });
});
server.on("connect", (_req, socket) => socket.destroy());
server.on("upgrade", (_req, socket) => socket.destroy());
server.listen(4313, "0.0.0.0");
