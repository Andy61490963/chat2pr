import { Resolver } from "node:dns";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";

// 有些網路的 DNS 會把「查無此網域」快取很久，新網域明明已生效卻一直解析失敗；
// 系統 DNS 連不上時改問公用 DNS，才能分辨是入口壞了還是本機 DNS 的問題。
const resolver = new Resolver({ timeout: 3000, tries: 1 });
resolver.setServers(["1.1.1.1", "8.8.8.8"]);
const publicLookup = (host, options, done) =>
  resolver.resolve4(host, (error, addresses) => {
    if (error) return done(error);
    if (options?.all)
      return done(
        null,
        addresses.map((address) => ({ address, family: 4 })),
      );
    done(null, addresses[0], 4);
  });

function probe(url, options) {
  return new Promise((done) => {
    const request = (url.protocol === "https:" ? httpsGet : httpGet)(
      url,
      { timeout: 10000, ...options },
      (response) => {
        response.resume();
        done({
          ok: response.statusCode === 200,
          status: response.statusCode,
          detail: `HTTP ${response.statusCode}`,
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("連線逾時")));
    request.on("error", (error) =>
      done({ ok: false, detail: error.code ?? error.message }),
    );
  });
}

/** 從外部網址檢查 /health。回傳 { ok, status?, detail }；沒有 status 代表連不上。 */
export async function publicHealth(publicUrl) {
  const url = new URL("/health", publicUrl);
  const direct = await probe(url, {});
  if (direct.status !== undefined || url.protocol !== "https:") return direct;
  const viaPublicDns = await probe(url, { lookup: publicLookup });
  return viaPublicDns.status !== undefined ? viaPublicDns : direct;
}
