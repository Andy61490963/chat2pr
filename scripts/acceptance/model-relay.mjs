import { createServer } from "node:http";

// 僅供本機驗收進入隔離模型；固定上游、路徑與方法，不提供 CONNECT 或任意代理。
createServer(async (request, response) => {
  if (!(
    (request.method === "GET" && request.url === "/health") ||
    (request.method === "POST" && request.url === "/embed")
  )) {
    response.writeHead(404).end();
    request.resume();
    return;
  }
  try {
    const parts = [];
    let length = 0;
    for await (const part of request) {
      length += part.length;
      if (length > 1024 * 1024) {
        response.writeHead(413).end();
        return;
      }
      parts.push(part);
    }
    const upstream = await fetch(`http://embedder:80${request.url}`, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body: request.method === "POST" ? Buffer.concat(parts) : undefined,
      signal: AbortSignal.timeout(35000),
    });
    response.writeHead(upstream.status, {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
    });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "隔離模型無法連線或逾時" }));
  }
}).listen(8080, "0.0.0.0");
