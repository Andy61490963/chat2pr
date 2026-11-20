import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const html = readFileSync(
  new URL("../docs/architecture-flow.html", import.meta.url),
  "utf8",
);
const script = readFileSync(
  new URL("../src/flow/architecture-flow.js", import.meta.url),
  "utf8",
);

it("系統架構動畫只載入同源資源，符合看板的 CSP", () => {
  // 看板 CSP：script-src 'self'，不允許行內腳本與 CDN；樣式可以行內。
  expect(html).not.toMatch(/<(script|link)[^>]+(src|href)="https?:/);
  expect(html).not.toMatch(/<script>(?!\s*<\/script>)/);
  expect(html).toContain(
    '<script type="module" src="/src/flow/architecture-flow.js"></script>',
  );
  expect(script).not.toMatch(/cdnjs|googleapis|unpkg|jsdelivr/);
  expect(script).toMatch(/import \{ gsap \} from "gsap"/);
});

it("動畫頁支援嵌入看板：主題、入口種類與高度回報", () => {
  expect(script).toContain('params.get("embed") === "1"');
  expect(script).toContain("agentflow-flow-height");
  expect(script).toContain("agentflow-flow-theme");
  for (const entry of ["cloudflare", "ngrok", "external", "unknown"])
    expect(script).toContain(`${entry}: [`);
});
