// 系統頁「系統架構」的動畫（docs/architecture-flow.html）。看板 CSP 只允許同源腳本，GSAP 與字型都由 Vite 打包。
import { gsap } from "gsap";
import "@fontsource-variable/inter";

  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var svg = document.getElementById("svg");
  var RM = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var hasGsap = true;
  // 嵌在看板「系統」頁時：?embed=1 隱藏標題並回報高度；?theme= 跟著看板外觀；?entry= 是固定 HTTPS 入口的種類。
  var params = new URLSearchParams(location.search);
  var ENTRY = { cloudflare: ["Cloudflare Tunnel", "固定 HTTPS 入口"], ngrok: ["ngrok", "固定 HTTPS 入口"], external: ["固定 HTTPS 入口", "自備程序"], unknown: ["固定 HTTPS 入口", "Cloudflare 或 ngrok"] };
  var entry = ENTRY[params.get("entry")] || ENTRY.cloudflare;
  function ent(t) {
    if (typeof t !== "string") return t;
    var ascii = /^[ -~]+$/.test(entry[0]);
    return t.replace(/ ?Cloudflare Tunnel ?/g, ascii ? " " + entry[0] + " " : entry[0]);
  }
  function setTheme(t) { if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t); }
  setTheme(params.get("theme"));

  // 顏色一律走 style，主題切換時跟著變。
  var STYLE_PROPS = { fill: 1, stroke: 1 };
  function el(tag, attrs, parent, text) {
    var n = document.createElementNS(NS, tag), st = "";
    for (var k in attrs) {
      if (STYLE_PROPS[k] && String(attrs[k]).indexOf("var(") === 0) st += k + ":" + attrs[k] + ";";
      else if (k === "style") st += attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    if (st) n.setAttribute("style", st);
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function op(n, v) { n.style.opacity = v; }

  // lucide 圖示（24×24、線寬 1.75）
  var ICON = {
    msg: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
    db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
    scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/>',
    cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
    relay: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
    github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.150.28-2.35 0-3.5 0 0-1 0-3 1.5-2.640-.5-5.360-.5-8 0C6 2 5 2 5 2c-.3 1.150-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
    pkg: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.730l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/>',
    dash: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    diff: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>',
    flask: '<path d="M14.5 2v17.5c0 1.4-1.1 2.5-2.5 2.5c-1.4 0-2.5-1.1-2.5-2.5V2"/><path d="M8.5 2h7"/><path d="M14.5 16h-5"/>',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    wifioff: '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    chevron: '<path d="m15 18-6-6 6-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'
  };
  function icon(name, x, y, size, color, parent) {
    var g = el("g", { transform: "translate(" + x + "," + y + ") scale(" + size / 24 + ")", fill: "none", "stroke-width": 1.75, "stroke-linecap": "round", "stroke-linejoin": "round", style: "stroke:" + color + ";" }, parent);
    g.innerHTML = ICON[name];
    return g;
  }
  function tile(name, x, y, tint, soft, parent, size) {
    var s = size || 34;
    el("rect", { x: x, y: y, width: s, height: s, rx: 9, fill: soft }, parent);
    icon(name, x + (s - 18) / 2, y + (s - 18) / 2, 18, tint, parent);
  }
  function pill(x, y, text, fg, bg, parent, opts) {
    opts = opts || {};
    var w = opts.w || (text.length * 12.6 + 20), h = opts.h || 24;
    var left = opts.anchor === "end" ? x - w : x;
    var g = el("g", {}, parent);
    var r = el("rect", { x: left, y: y, width: w, height: h, rx: opts.rx || 6, fill: bg }, g);
    var t = el("text", { x: left + w / 2, y: y + h / 2 + 4.5, "text-anchor": "middle", style: "fill:" + fg + ";font:600 12px var(--font)" }, g, text);
    return { g: g, r: r, t: t };
  }

  // ---------- 外框與區域 ----------
  var frame = document.getElementById("frame");
  el("rect", { x: 330, y: 62, width: 1090, height: 812, rx: 22, class: "host" }, frame);
  el("text", { x: 352, y: 94, class: "t-zone" }, frame, "這台 WINDOWS 主機・DOCKER DESKTOP");
  el("text", { x: 40, y: 94, class: "t-zone" }, frame, "LINE 與你");
  el("text", { x: 1450, y: 94, class: "t-zone" }, frame, "外部服務");

  // ---------- 元件 ----------
  var C = {
    line: { x: 40, y: 110, w: 250, h: 430, title: "LINE 群組", sub: "產品討論群（5）", tint: "var(--line)", soft: "var(--line-soft)", ic: "msg" },
    admin: { x: 40, y: 600, w: 250, h: 250, title: "你（管理者）", sub: "看板・LINE 私訊", tint: "var(--brand)", soft: "var(--brand-soft)", ic: "dash" },
    tunnel: { x: 360, y: 150, w: 210, h: 104, title: entry[0], ts: 15.5, sub: entry[1], tint: "var(--cf)", soft: "var(--cf-soft)", ic: "cloud" },
    app: { x: 600, y: 110, w: 300, h: 336, title: "app 容器", port: ":4310", tint: "var(--brand)", soft: "var(--brand-soft)", ic: "server",
      lines: ["Webhook 驗簽收訊", "等群組安靜再判讀", "任務與看板 API", "佇列 pg-boss", "LINE 推播・GitHub App"] },
    db: { x: 600, y: 480, w: 140, h: 130, title: "PostgreSQL", sub: "訊息・任務", tint: "var(--db)", soft: "var(--db-soft)", ic: "db" },
    emb: { x: 760, y: 480, w: 140, h: 130, title: "embedder", sub: "本機向量模型", tint: "var(--db)", soft: "var(--db-soft)", ic: "scan" },
    runner: { x: 960, y: 110, w: 220, h: 90, title: "執行器", port: "主機 :4312", tint: "var(--brand)", soft: "var(--brand-soft)", ic: "cpu", row: true },
    relay: { x: 1200, y: 110, w: 190, h: 90, title: "訂閱轉送", port: ":4313・egress-ai", tint: "var(--ai)", soft: "var(--ai-soft)", ic: "relay", row: true },
    egress: { x: 960, y: 664, w: 300, h: 84, title: "egress", sub: "Squid 白名單代理", tint: "var(--cf)", soft: "var(--cf-soft)", ic: "shield", row: true },
    gpt: { x: 1450, y: 110, w: 132, h: 112, title: "ChatGPT", sub: "Codex 推論", tint: "var(--ai)", soft: "var(--ai-soft)", ic: "sparkles" },
    gh: { x: 1450, y: 380, w: 132, h: 120, title: "GitHub", sub: "原始碼・PR", tint: "var(--fg)", soft: "var(--muted)", ic: "github" },
    pkg: { x: 1450, y: 650, w: 132, h: 112, title: "套件來源", sub: "npm・NuGet", tint: "var(--fg)", soft: "var(--muted)", ic: "pkg" }
  };
  var nodesG = document.getElementById("nodes"), nodes = {};
  Object.keys(C).forEach(function (id) {
    var c = C[id];
    var g = el("g", { class: "node", id: "n-" + id, style: "--tint:" + c.tint }, nodesG);
    el("rect", { class: "halo", x: c.x - 8, y: c.y - 8, width: c.w + 16, height: c.h + 16, rx: 22, fill: c.tint, filter: "url(#blur12)" }, g);
    el("rect", { class: "node-box", x: c.x, y: c.y, width: c.w, height: c.h, rx: 14 }, g);
    var dot = el("circle", { class: "livedot", cx: c.x + c.w - 14, cy: c.y + 14, r: 4, fill: c.tint }, g);
    if (c.w <= 150) {
      tile(c.ic, c.x + 14, c.y + 14, c.tint, c.soft, g);
      el("text", { x: c.x + 14, y: c.y + 76, class: "t-title", style: "font-size:16.5px" }, g, c.title);
      el("text", { x: c.x + 14, y: c.y + 96, class: "t-sub", style: "font-size:12.5px" }, g, c.sub);
    } else if (c.row) {
      tile(c.ic, c.x + 14, c.y + (c.h - 34) / 2, c.tint, c.soft, g);
      el("text", { x: c.x + 60, y: c.y + c.h / 2 - 2, class: "t-title" }, g, c.title);
      el("text", { x: c.x + 60, y: c.y + c.h / 2 + 18, class: c.port ? "t-mono" : "t-sub" }, g, c.port || c.sub);
    } else {
      tile(c.ic, c.x + 14, c.y + 14, c.tint, c.soft, g);
      el("text", { x: c.x + 58, y: c.y + 30, class: "t-title", style: c.ts ? "font-size:" + c.ts + "px" : "" }, g, c.title);
      el("text", { x: c.x + 58, y: c.y + 49, class: c.port ? "t-mono" : "t-sub" }, g, c.port || c.sub);
    }
    if (c.lines) c.lines.forEach(function (t, i) {
      var y = c.y + 84 + i * 40;
      el("rect", { x: c.x + 14, y: y, width: c.w - 28, height: 32, rx: 8, fill: "var(--muted)" }, g);
      el("text", { x: c.x + 26, y: y + 21, style: "fill:var(--muted-fg);font:600 11.5px var(--mono)" }, g, String(i + 1).padStart(2, "0"));
      el("text", { x: c.x + 52, y: y + 21, class: "t-line" }, g, t);
    });
    nodes[id] = { g: g, dot: dot };
  });
  if (hasGsap && !RM) Object.keys(nodes).forEach(function (id) { gsap.to(nodes[id].dot, { attr: { r: 7, "fill-opacity": 0.35 }, duration: 0.8, yoyo: true, repeat: -1, ease: "sine.inOut" }); });

  // app 狀態列與倒數
  el("rect", { x: 614, y: 392, width: 272, height: 40, rx: 10, fill: "var(--brand-soft)" }, nodes.app.g);
  var appDot = el("circle", { cx: 634, cy: 412, r: 5, fill: "var(--brand)" }, nodes.app.g);
  var appStatus = el("text", { x: 648, y: 417, style: "fill:var(--brand-fg);font:600 14px var(--font)" }, nodes.app.g, "");
  var ring = el("g", { style: "opacity:0" }, nodes.app.g);
  el("circle", { cx: 860, cy: 140, r: 18, fill: "none", stroke: "var(--border)", "stroke-width": 4 }, ring);
  var ringArc = el("circle", { cx: 860, cy: 140, r: 18, fill: "none", stroke: "var(--brand)", "stroke-width": 4, "stroke-dasharray": 113.1, "stroke-dashoffset": 0, transform: "rotate(-90 860 140)", "stroke-linecap": "round" }, ring);
  var ringText = el("text", { x: 860, y: 144.5, "text-anchor": "middle", style: "fill:var(--fg);font:600 12px var(--mono)" }, ring, "60");

  // ---------- 連線 ----------
  var P = {
    line_tunnel: "M290 202 C 322 202, 330 202, 360 202",
    tunnel_app: "M570 202 L600 202",
    app_db: "M670 446 L670 480",
    db_emb: "M740 545 L760 545",
    app_emb: "M830 446 L830 480",
    out_line: "M690 110 L690 40 L165 40 L165 110",
    app_runner: "M900 155 L960 155",
    runner_slot: "M1070 200 L1070 240",
    slot_relay: "M1295 240 L1295 200",
    relay_gpt: "M1390 155 L1450 155",
    app_admin: "M600 360 C 470 360, 430 725, 290 725",
    gh_slot: "M1450 435 L1390 435",
    slot_egress: "M1110 620 L1110 664",
    egress_pkg: "M1260 706 L1450 706",
    egress_bad: "M1260 732 L1356 732",
    app_gh: "M900 425 L930 425 L930 842 L1516 842 L1516 500",
    gh_hook: "M1516 380 L1516 20 L465 20 L465 150",
    admin_gh: "M290 810 Q 900 905 1490 490"
  };
  var wires = document.getElementById("wires"), flows = document.getElementById("flows"), trails = document.getElementById("trails");
  var pathEls = {}, trailEls = {}, flowEls = {};
  Object.keys(P).forEach(function (id) {
    if (id !== "egress_bad") el("path", { d: P[id], class: "wire" }, wires);
    pathEls[id] = el("path", { d: P[id], fill: "none", stroke: "none" }, wires);
    flowEls[id] = el("path", { d: P[id], class: "flow", stroke: "var(--brand)" }, flows);
    trailEls[id] = el("path", { d: P[id], class: "trail", stroke: "var(--brand)" }, trails);
  });

  // ---------- LINE 聊天 ----------
  var extras = document.getElementById("extras");
  var chat = el("g", {}, extras);
  el("rect", { x: 52, y: 166, width: 226, height: 362, rx: 10, fill: "var(--chat-bg)" }, chat);
  el("rect", { x: 52, y: 166, width: 226, height: 30, rx: 10, fill: "var(--card)" }, chat);
  icon("chevron", 58, 172, 18, "var(--muted-fg)", chat);
  el("text", { x: 165, y: 186, "text-anchor": "middle", style: "fill:var(--fg);font:600 12.5px var(--font)" }, chat, "產品討論群（5）");
  var chatBody = el("g", { "clip-path": "url(#clip-chat)" }, chat);
  var bubbles = {};
  function bubble(id, side, lines, y) {
    var g = el("g", { style: "opacity:0" }, chatBody);
    var lh = 18, h = lines.length * lh + 14, w = 0;
    lines.forEach(function (t) { w = Math.max(w, t.length * 12.4 + 18); });
    w = Math.min(w, side === "me" ? 196 : 172);
    var top = y;
    if (side === "me") {
      var x = 270 - w;
      el("rect", { x: x, y: top, width: w, height: h, rx: 12, fill: "var(--chat-me)" }, g);
      lines.forEach(function (t, i) { el("text", { x: x + 9, y: top + 19 + i * lh, style: "fill:var(--chat-me-fg);font:400 12.5px var(--font)" }, g, t); });
      el("text", { x: x - 4, y: top + h - 3, "text-anchor": "end", style: "fill:var(--fg);opacity:.55;font:400 9.5px var(--font)" }, g, "已讀 4");
    } else {
      el("circle", { cx: 72, cy: top + 13, r: 12, fill: "var(--brand)" }, g);
      el("text", { x: 72, y: top + 17, "text-anchor": "middle", style: "fill:var(--on-brand);font:700 10px var(--font)" }, g, "AF");
      el("text", { x: 90, y: top + 9, style: "fill:var(--fg);opacity:.75;font:500 10.5px var(--font)" }, g, "AgentFlow");
      top += 14;
      el("rect", { x: 90, y: top, width: w, height: h, rx: 12, fill: "var(--chat-bot)" }, g);
      lines.forEach(function (t, i) { el("text", { x: 99, y: top + 19 + i * lh, style: "fill:var(--fg);font:400 12.5px var(--font)" }, g, t); });
    }
    bubbles[id] = g;
    return top + h;
  }
  var B = {
    change: [
      ["m1", "me", ["/任務 把首頁的訂購按鈕", "改成綠色，點了還是要", "能下單"]],
      ["r1", "bot", ["收到，我會把這則需求", "整理好交給管理者確", "認，處理完會在這裡", "回報。"]],
      ["m2", "me", ["對了，手機版也一樣"]],
      ["f1", "bot", ["「首頁訂購按鈕改綠", "色」已修改完成，等", "管理者檢視後合併：", "…/pull/42"]]
    ],
    query: [
      ["m1", "me", ["/任務 ShopWeb 的訂購按", "鈕在哪個元件？按下去", "呼叫哪支 API？"]],
      ["r1", "bot", ["收到，我會把這則需求", "整理好交給管理者確", "認，處理完會在這裡", "回報。"]],
      ["m2", "me", ["手機版也是同一個嗎？"]],
      ["f1", "bot", ["「訂購按鈕在哪」的查", "詢結果：OrderButton", "…回覆打「詳細」看全", "文"]]
    ]
  };
  function buildBubbles(mode) {
    Object.keys(bubbles).forEach(function (k) { bubbles[k].remove(); delete bubbles[k]; });
    var y = 202;
    B[mode].forEach(function (b) { y = bubble(b[0], b[1], b[2], y) + 6; });
  }

  // ---------- 管理者：迷你收件匣 ----------
  var adm = el("g", {}, extras);
  el("rect", { x: 54, y: 670, width: 222, height: 166, rx: 10, fill: "var(--muted)" }, adm);
  var admPill = pill(66, 682, "收件匣", "var(--muted-fg)", "var(--card)", adm);
  var admTitle = el("text", { x: 66, y: 732, style: "fill:var(--fg);font:600 14px var(--font)" }, adm, "目前沒有待處理");
  var admRepo = el("text", { x: 66, y: 754, style: "fill:var(--muted-fg);font:400 11.5px var(--mono)" }, adm, "");
  var admBtn = el("g", { style: "opacity:0" }, adm);
  el("rect", { x: 66, y: 772, width: 198, height: 34, rx: 8, fill: "var(--brand)" }, admBtn);
  el("text", { x: 165, y: 794, "text-anchor": "middle", style: "fill:var(--on-brand);font:600 13px var(--font)" }, admBtn, "確認專案並核准修改");
  var cursor = el("g", { style: "opacity:0" }, adm);
  el("path", { d: "M0 0 L0 18 L5 13 L9 21 L12 20 L8 12 L15 12 Z", fill: "var(--fg)", stroke: "var(--card)", "stroke-width": 1.5 }, cursor);

  // ---------- 判讀容器、工作容器 ----------
  var slot = el("g", { style: "opacity:0" }, extras);
  el("rect", { x: 952, y: 232, width: 446, height: 396, rx: 18, fill: "var(--brand)", filter: "url(#blur12)", style: "opacity:.14" }, slot);
  el("rect", { x: 960, y: 240, width: 430, height: 380, rx: 14, fill: "var(--card)", stroke: "var(--brand)", "stroke-width": 2 }, slot);
  tile("box", 974, 254, "var(--brand)", "var(--brand-soft)", slot);
  el("text", { x: 1018, y: 270, class: "t-title" }, slot, "工作容器");
  el("text", { x: 1018, y: 289, class: "t-sub" }, slot, "拋棄式・非 root・根目錄唯讀");
  var netBadge = el("g", { style: "opacity:0" }, slot);
  el("rect", { x: 1268, y: 258, width: 108, height: 26, rx: 6, fill: "var(--danger-soft)" }, netBadge);
  icon("wifioff", 1276, 263, 16, "var(--danger)", netBadge);
  el("text", { x: 1298, y: 276, style: "fill:var(--danger);font:600 12px var(--font)" }, netBadge, "沒有網路");
  var roBadge = el("g", { style: "opacity:0" }, slot);
  el("rect", { x: 1268, y: 258, width: 108, height: 26, rx: 6, fill: "var(--info-soft)" }, roBadge);
  icon("lock", 1276, 263, 16, "var(--info)", roBadge);
  el("text", { x: 1298, y: 276, style: "fill:var(--info);font:600 12px var(--font)" }, roBadge, "唯讀審查");
  el("text", { x: 976, y: 608, style: "fill:var(--muted-fg);font:400 12px var(--font)" }, slot, "沒有 Docker socket・限 CPU 與記憶體・最長 30 分鐘");
  var PH = [["download", "準備原始碼"], ["pkg", "安裝相依套件"], ["code", "Codex 修改程式"], ["diff", "收集差異"], ["flask", "跑測試"], ["eye", "獨立審查"]];
  var phases = PH.map(function (p, i) {
    var y = 306 + i * 47;
    var g = el("g", {}, slot);
    el("rect", { x: 976, y: y, width: 398, height: 40, rx: 9, fill: "var(--muted)" }, g);
    var bar = el("rect", { x: 976, y: y, width: 0, height: 40, rx: 9, fill: "var(--brand-soft)" }, g);
    el("text", { x: 990, y: y + 25, style: "fill:var(--muted-fg);font:600 11.5px var(--mono)" }, g, String(i));
    icon(p[0], 1006, y + 11, 18, "var(--fg)", g);
    el("text", { x: 1034, y: y + 25, style: "fill:var(--fg);font:500 14px var(--font)" }, g, p[1]);
    var stG = el("g", {}, g);
    return { g: g, bar: bar, stG: stG, y: y };
  });
  var tri = el("g", { style: "opacity:0" }, extras);
  el("rect", { x: 952, y: 232, width: 446, height: 216, rx: 18, fill: "var(--ai)", filter: "url(#blur12)", style: "opacity:.14" }, tri);
  el("rect", { x: 960, y: 240, width: 430, height: 200, rx: 14, fill: "var(--card)", stroke: "var(--ai)", "stroke-width": 2 }, tri);
  tile("sparkles", 974, 254, "var(--ai)", "var(--ai-soft)", tri);
  el("text", { x: 1018, y: 270, class: "t-title" }, tri, "一次性判讀容器");
  el("text", { x: 1018, y: 289, class: "t-sub" }, tri, "判斷完就刪除，容器不持有登入檔");
  var triSkel = el("g", { style: "opacity:0" }, tri);
  [300, 220, 260, 140].forEach(function (w, i) { el("rect", { class: "skel", x: 980, y: 318 + i * 27, width: w, height: 14, rx: 7, fill: "var(--muted)", style: "animation-delay:" + i * 0.12 + "s" }, triSkel); });
  var triRows = [0, 1, 2, 3].map(function (i) {
    var g = el("g", { style: "opacity:0" }, tri);
    var k = el("text", { x: 980, y: 330 + i * 27, style: "fill:var(--muted-fg);font:500 12.5px var(--font)" }, g, "");
    var v = el("text", { x: 1040, y: 330 + i * 27, style: "fill:var(--fg);font:500 13.5px var(--font)" }, g, "");
    return { g: g, k: k, v: v };
  });
  var TRI = {
    change: [["種類", "修改"], ["專案", "example-org/ShopWeb"], ["驗收", "桌機與手機版按鈕為綠色"], ["風險", "低"]],
    query: [["種類", "查詢・明確指名專案"], ["專案", "example-org/ShopWeb"], ["機密", "不需要"], ["風險", "低"]]
  };

  // 結果標記
  var prTag = el("g", { style: "opacity:0" }, extras);
  el("rect", { x: 1450, y: 510, width: 132, height: 30, rx: 8, fill: "var(--good-soft)" }, prTag);
  icon("pr", 1460, 516, 18, "var(--good)", prTag);
  var prText = el("text", { x: 1484, y: 530, style: "fill:var(--good);font:600 13px var(--mono)" }, prTag, "PR #42");
  var noEntry = el("g", { style: "opacity:0" }, extras);
  el("circle", { cx: 1370, cy: 732, r: 14, fill: "var(--danger-soft)", stroke: "var(--danger)", "stroke-width": 2 }, noEntry);
  icon("x", 1362, 724, 16, "var(--danger)", noEntry);
  el("text", { x: 1340, y: 772, style: "fill:var(--danger);font:600 12px var(--font)" }, noEntry, "白名單外，拒絕");

  // ---------- 封包與彗星尾巴 ----------
  var packet = document.getElementById("packet"), tailG = document.getElementById("tail");
  var pHalo = el("circle", { r: 26, fill: "var(--brand)", filter: "url(#blur6)", style: "opacity:.45" }, packet);
  var pCore = el("circle", { r: 15, fill: "var(--brand)", stroke: "var(--card)", "stroke-width": 3 }, packet);
  var pIcon = el("g", { transform: "translate(-8,-8) scale(.6667)", fill: "none", "stroke-width": 2.25, "stroke-linecap": "round", "stroke-linejoin": "round", style: "stroke:var(--card)" }, packet);
  var tails = [0.03, 0.06, 0.09, 0.12, 0.15].map(function (lag, i) { return { lag: lag, c: el("circle", { r: 9 - i * 1.5, fill: "var(--brand)", style: "opacity:0" }, tailG) }; });
  var PICON = { "訊息": "msg", "補充": "msg", "追問": "msg", "收到": "msg", "群組": "msg", "私訊": "msg", "存檔": "db", "結果": "db", "檢索": "scan", "比對": "scan",
    "判讀": "sparkles", "推論": "sparkles", "回應": "sparkles", "審查": "eye", "通過": "check", "待審核": "dash", "核准": "check", "任務 #128": "box",
    "原始碼": "download", "下載": "pkg", "套件": "pkg", "外連": "x", "PR": "pr", "報告": "file", "合併": "pr", "Webhook": "github" };
  function setPacket(label, color) {
    var c = color || "var(--brand)";
    pHalo.style.fill = c; pCore.style.fill = c;
    tails.forEach(function (t) { t.c.style.fill = c; });
    pIcon.innerHTML = ICON[PICON[label] || "msg"];
    pIcon.style.stroke = c === "var(--fg)" ? "var(--bg)" : "var(--card)";
  }
  function pointOn(id, t) { var p = pathEls[id]; return p.getPointAtLength(Math.max(0, Math.min(1, t)) * p.getTotalLength()); }
  function placeAt(id, t, rev) {
    var pt = pointOn(id, rev ? 1 - t : t);
    packet.setAttribute("transform", "translate(" + pt.x + "," + pt.y + ")");
    tails.forEach(function (tl, i) {
      var tt = t - tl.lag;
      if (tt <= 0) { tl.c.style.opacity = 0; return; }
      var q = pointOn(id, rev ? 1 - tt : tt);
      tl.c.setAttribute("cx", q.x); tl.c.setAttribute("cy", q.y); tl.c.style.opacity = 0.55 - i * 0.12;
    });
  }
  function hideTail() { tails.forEach(function (t) { t.c.style.opacity = 0; }); }

  // ---------- 鏡頭 ----------
  var CAM = { full: [0, 0, 1600, 900], entry: [10, 20, 960, 540], core: [500, 70, 860, 484], ai: [660, 50, 940, 529], work: [720, 220, 880, 495], approve: [0, 205, 1150, 647] };
  var cam = { x: 0, y: 0, w: 1600, h: 900 };
  function applyCam() { svg.setAttribute("viewBox", cam.x + " " + cam.y + " " + cam.w + " " + cam.h); }

  // ---------- 場景 ----------
  var ALL = [
    { title: "成員在群組提需求", where: "LINE → Cloudflare Tunnel → app", cam: "entry", focus: ["line", "tunnel", "app"],
      text: { change: "王小明在「產品討論群」打 /任務 加上需求。LINE 平台把這則訊息用 Webhook（HTTPS POST）送到這台主機的固定網址，經 Cloudflare Tunnel 進到 app 容器。主機不用開放任何對外連接埠。",
              query: "林佳穎想知道訂購按鈕在程式哪裡，用 /任務 問。LINE 平台把這則訊息用 Webhook（HTTPS POST）送到這台主機的固定網址，經 Cloudflare Tunnel 進到 app 容器。主機不用開放任何對外連接埠。" },
      chips: ["指令模式：/任務 開頭", "Webhook", "約 1 秒"],
      data: { change: "<k>POST</k> https://固定網址/webhooks/line\n<k>X-Line-Signature:</k> 3q2+7wQ…  <k>(HMAC-SHA256)</k>\n{\n  \"type\": \"message\",\n  \"source\": { \"groupId\": \"C1f3…\" },\n  \"message\": {\n    \"type\": \"text\",\n    \"text\": <s>\"/任務 把首頁的訂購按鈕改成綠色…\"</s>\n  },\n  \"replyToken\": \"b60d…\"\n}",
              query: "<k>POST</k> https://固定網址/webhooks/line\n<k>X-Line-Signature:</k> 3q2+7wQ…  <k>(HMAC-SHA256)</k>\n{\n  \"type\": \"message\",\n  \"message\": {\n    \"type\": \"text\",\n    \"text\": <s>\"/任務 ShopWeb 的訂購按鈕在哪個元件？…\"</s>\n  },\n  \"replyToken\": \"b60d…\"\n}" },
      end: { bub: ["m1"], app: "收到 Webhook" },
      anim: function (tl) { showBubble(tl, "m1"); travel(tl, "line_tunnel", 1.1, "訊息"); travel(tl, "tunnel_app", 0.6, "訊息"); status(tl, "收到 Webhook"); } },

    { title: "驗簽、存檔，先回「收到」", where: "app・PostgreSQL・LINE", cam: "entry", focus: ["app", "db", "line"],
      text: "app 用 Channel Secret 驗證簽章，沒簽或簽錯直接回 401。通過後把訊息存進 PostgreSQL；有圖片就在背景下載。接著用這則訊息附的 reply token 回「收到」，reply token 的回覆不算 LINE 每月推播額度。回覆是 app 直接連到 LINE，不經過通道。",
      chips: ["簽章錯誤回 401", "reply token 不算額度", "原文保留 30 天"],
      data: "<ok>✓ 簽章正確</ok>\n\n<k>messages 新增一列</k>\n  id          \"5129…\"\n  group_id    \"C1f3…\"\n  type        \"text\"\n  received_at 10:02:11\n\n<k>回覆（reply token）</k>\n<s>收到，我會把這則需求整理好交給管理者確認，</s>\n<s>處理完會在這裡回報。</s>",
      end: { bub: ["m1", "r1"], app: "已存檔・已回收到" },
      anim: function (tl) { travel(tl, "app_db", 0.6, "存檔"); status(tl, "已存檔"); travel(tl, "out_line", 1.4, "收到", "var(--line)"); showBubble(tl, "r1"); status(tl, "已存檔・已回收到"); } },

    { title: "等群組安靜下來", where: "app", cam: "entry", focus: ["line", "app"],
      text: "大家常把一件事拆成好幾句講。app 不會一收到就判讀，而是等這個群組安靜 60 秒（最多累積 5 分鐘）；只是引用機器人回答的追問，等 5 秒就好。這段時間的碎片訊息會合在一起判讀。",
      chips: ["安靜 60 秒", "最長 5 分鐘", "引用追問 5 秒"],
      data: { change: "<k>待判讀（產品討論群）</k>\n  10:02:11  /任務 把首頁的訂購按鈕改成綠色…\n  10:02:40  對了，手機版也一樣\n<s>  10:03:40  安靜滿 60 秒 → 合併 2 則、排入判讀</s>",
              query: "<k>待判讀（產品討論群）</k>\n  10:02:11  /任務 ShopWeb 的訂購按鈕在哪個元件？…\n  10:02:40  手機版也是同一個嗎？\n<s>  10:03:40  安靜滿 60 秒 → 合併 2 則、排入判讀</s>" },
      end: { bub: ["m1", "r1", "m2"], app: "合併 2 則・排入判讀" },
      anim: function (tl) { showBubble(tl, "m2"); travel(tl, "line_tunnel", 0.8, "補充"); travel(tl, "tunnel_app", 0.4, "補充"); countdown(tl, 2.6); status(tl, "合併 2 則・排入判讀"); } },

    { title: "找回上下文", where: "app・embedder・PostgreSQL", cam: "core", focus: ["app", "db", "emb"],
      text: "判讀前，app 用本機的向量模型（embedder，跑在這台主機，資料不送到外部）檢索：最近的對話、群組記憶、過去同專案的任務結果。AI 才知道「首頁」指的是哪個專案、以前怎麼做。",
      chips: ["本機向量模型", "群組記憶", "過去任務結果"],
      data: "<k>群組記憶</k>\n  「訂購相關都改 ShopWeb 前端」\n\n<k>過去任務</k>\n  #97 訂購頁按鈕加 loading  <ok>已合併</ok>\n      example-org/ShopWeb\n\n<k>相似的舊對話</k>\n  3 則（相似度 0.82・0.77・0.71）",
      end: { app: "上下文已備妥" },
      anim: function (tl) { travel(tl, "app_emb", 0.6, "檢索"); travel(tl, "db_emb", 0.5, "比對", null, true); travel(tl, "app_db", 0.6, "結果", null, true); status(tl, "上下文已備妥"); } },

    { title: "AI 判讀需求", where: "執行器・判讀容器・訂閱轉送・ChatGPT", cam: "ai", focus: ["app", "runner", "relay", "gpt"],
      text: { change: "app 請主機上的執行器開一個用完即丟的判讀容器。容器裡沒有 ChatGPT 登入檔，推論經「訂閱轉送」與 egress-ai 送到 ChatGPT。自動辨識會略過你和同事的分工與未定案討論。明確需求會判斷修改或查詢、目標專案和風險，並寫出驗收條件；缺必要資訊時只問一件事。",
              query: "app 請主機上的執行器開一個用完即丟的判讀容器。容器裡沒有 ChatGPT 登入檔，推論經「訂閱轉送」與 egress-ai 送到 ChatGPT。AI 判斷這是查詢，而且明確指名了專案；要求交出密碼、金鑰實際值的查詢才會被擋下等人確認。" },
      chips: ["一次性容器", "容器不持有登入", "固定風險規則"],
      data: { change: "{\n  \"kind\":    <s>\"修改\"</s>,\n  \"project\": \"example-org/ShopWeb\",\n  \"title\":   \"首頁訂購按鈕改綠色\",\n  \"acceptance\": [\n    \"桌機與手機版首頁的訂購按鈕為綠色\",\n    \"點擊後仍能完成下單\"\n  ],\n  \"assumptions\": [\"沿用品牌綠\"],\n  \"risk\": \"低\"\n}",
              query: "{\n  \"kind\":    <s>\"查詢\"</s>,\n  \"project\": \"example-org/ShopWeb\",\n  \"named\":   true,\n  \"title\":   \"訂購按鈕在哪\",\n  \"secrets\": false,\n  \"risk\":    \"低\"\n}" },
      end: { tri: true, triRows: 4, app: "判讀完成" },
      anim: function (tl) {
        travel(tl, "app_runner", 0.5, "判讀");
        fadeIn(tl, tri); tl.set(triSkel, { opacity: 1 }); travel(tl, "runner_slot", 0.4, "判讀");
        travel(tl, "slot_relay", 0.4, "推論", "var(--ai)"); travel(tl, "relay_gpt", 0.5, "推論", "var(--ai)");
        travel(tl, "relay_gpt", 0.5, "結果", "var(--ai)", true); travel(tl, "slot_relay", 0.4, "結果", "var(--ai)", true);
        tl.to(triSkel, { opacity: 0, duration: 0.2 });
        triRows.forEach(function (r) { tl.fromTo(r.g, { opacity: 0, x: -8 }, { opacity: 1, x: 0, duration: 0.25 }); });
        status(tl, "判讀完成");
      } },

    { title: { change: "修改一定先等你點頭", query: "明確的查詢可以自動開始" }, where: { change: "看板收件匣・LINE 私訊", query: "app" }, cam: { change: "approve", query: "core" }, focus: { change: ["app", "admin"], query: ["app"] },
      text: { change: "修改程式一律要人確認。任務進到看板收件匣「待審核」，你也會收到 LINE 私訊。打開任務詳情核對目標儲存庫、需求與假設，按「確認專案並核准修改」。就算群組只綁了一個專案，也不能省略這一步。",
              query: "這次查詢明確指名已綁定的專案，判讀完就直接排程。索取機密實際值的查詢仍須人工確認。當系統無法確認目標時，你可以在收件匣查看符合需求的未綁定專案，管理者可一鍵綁定並指定，再確認任務。" },
      chips: { change: ["待審核", "核准只適用這個版本", "不會自動部署"], query: ["自動排程", "唯讀執行", "回答會遮蔽機密"] },
      data: { change: "<k>任務 #128</k>  待審核\n  首頁訂購按鈕改綠色\n  example-org/ShopWeb ← main\n  我先這樣假設：沿用品牌綠\n\n<s>[ 確認專案並核准修改 ]</s>  ← 你按下\n<ok>✓ 已核准 v1</ok>",
              query: "<k>任務 #128</k>  查詢・自動排程\n  訂購按鈕在哪\n  example-org/ShopWeb ← main\n  依據：本次明確指名「ShopWeb」" },
      end: { tri: false, adm: { change: "approved", query: "none" }, app: { change: "已核准・排隊中", query: "自動排程・排隊中" } },
      anim: function (tl, mode) {
        tl.to(tri, { opacity: 0, duration: 0.4 });
        if (mode === "change") {
          travel(tl, "app_admin", 1.0, "待審核");
          tl.call(function () { setAdmin("pending"); });
          tl.fromTo(admBtn, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.35 });
          tl.fromTo(cursor, { opacity: 0, x: 250, y: 860 }, { opacity: 1, x: 200, y: 792, duration: 0.8, ease: "power2.out" });
          tl.to(admBtn, { scale: 0.95, svgOrigin: "165 789", duration: 0.1 });
          tl.to(admBtn, { scale: 1, svgOrigin: "165 789", duration: 0.15 });
          tl.call(function () { setAdmin("approved"); });
          tl.to(cursor, { opacity: 0, duration: 0.3 });
          travel(tl, "app_admin", 1.0, "核准", null, true);
          status(tl, "已核准・排隊中");
        } else {
          status(tl, "自動排程・排隊中"); tl.to({}, { duration: 1.2 });
        }
      } },

    { title: "排進佇列，交給執行器", where: "pg-boss → 執行器 → 工作容器", cam: "ai", focus: ["app", "runner"],
      text: "任務進入持久化佇列（pg-boss）。如果你設定了 Codex 個人保留比例，任一額度視窗用到 chat2pr 的上限時，判讀、開發、驗證與查詢都會等待，額度恢復後自動繼續。輪到任務時（同時執行預設 2 件），執行器建立非 root、根目錄唯讀且沒有 Docker socket 的工作容器，限制 CPU 與記憶體，每件最長 30 分鐘。",
      chips: ["同時 2 件", "最長 30 分鐘", "非 root・唯讀"],
      data: "<k>訂閱額度檢查</k>\n  你保留 60% 時，任一視窗用到 40% 就等待額度\n\n<k>建立工作容器</k>\n  User            非 root\n  ReadonlyRootfs  true\n  CapDrop         ALL\n  Docker socket   <no>不掛載</no>\n  Memory          2 GiB\n  PidsLimit       512\n  期限            30 分鐘",
      end: { slot: true, app: "執行中" },
      anim: function (tl) { touch("slot"); travel(tl, "app_runner", 0.6, "任務 #128"); travel(tl, "runner_slot", 0.5, "任務 #128"); tl.fromTo(slot, { opacity: 0, scale: 0.96, svgOrigin: "1175 240" }, { opacity: 1, scale: 1, svgOrigin: "1175 240", duration: 0.5, ease: "back.out(1.6)" }); status(tl, "執行中"); } },

    { title: "準備原始碼", where: "執行器 → GitHub", cam: "work", focus: ["gh"],
      text: "執行器用短期 GitHub 權杖抓這次確認的分支與 commit；同一個版本有本機快取就直接用。工作容器自己拿不到 GitHub 寫入權限，之後開 PR 也是 app 做的。",
      chips: ["短期權杖", "固定 commit", "本機快取"],
      data: "<k>來源</k>\n  example-org/ShopWeb\n  main @ <s>4f2a91c</s>\n  快取命中，不重新下載\n\n<k>工作容器內</k>\n  /workspace         可寫的工作副本\n  /agentflow/base    <k>唯讀的原始基底</k>",
      end: { ph: ["done"] },
      anim: function (tl) { phase(tl, 0, "run"); travel(tl, "gh_slot", 0.7, "原始碼", "var(--fg)"); phase(tl, 0, "done"); } },

    { title: "安裝相依套件", where: "工作容器 → egress → 套件來源", cam: "work", focus: ["egress", "pkg"],
      text: "先以 root 安裝審查放行的系統套件，存成這個專案的衍生映像，之後直接重用；測試要用 SQL Server 時改用內含 SQL Server 的映像。接著以非 root 執行專案的安裝命令。所有下載都只能經 egress 白名單代理，其他網址一律擋下。你也可以在專案頁查看環境驗證的排隊、安裝、測試或 AI 調整進度。",
      chips: ["白名單代理", "衍生映像可重用", "非 root 安裝"],
      data: "$ npm ci\n  CONNECT registry.npmjs.org:443   <ok>✓ 白名單內</ok>\n  CONNECT tracker.example.net:443  <no>✕ 拒絕</no>\n\n<k>專案看板</k>  驗證中\n你的專案正在安裝相依套件。",
      end: { ph: ["done", "done"] },
      anim: function (tl) {
        phase(tl, 1, "run"); travel(tl, "slot_egress", 0.4, "下載"); travel(tl, "egress_pkg", 0.7, "下載");
        travel(tl, "egress_pkg", 0.7, "套件", "var(--fg)", true); travel(tl, "slot_egress", 0.4, "套件", "var(--fg)", true);
        travel(tl, "slot_egress", 0.4, "外連", "var(--danger)"); travel(tl, "egress_bad", 0.5, "外連", "var(--danger)");
        tl.fromTo(noEntry, { opacity: 0, scale: 0.6, svgOrigin: "1370 732" }, { opacity: 1, scale: 1, svgOrigin: "1370 732", duration: 0.3, ease: "back.out(2)" });
        tl.to(noEntry, { opacity: 0, duration: 0.4, delay: 0.9 });
        phase(tl, 1, "done");
      } },

    { title: { change: "Codex 修改程式", query: "Codex 調查程式" }, where: "工作容器 → 訂閱轉送 → ChatGPT", cam: "ai", focus: ["relay", "gpt"],
      text: { change: "Codex 在容器裡讀程式、改程式，推論一樣經訂閱轉送到 ChatGPT；缺套件時可以經白名單下載。它只看得到這次的需求、驗收條件與專案檔案。",
              query: "Codex 在容器裡讀程式、必要時執行指令，推論經訂閱轉送到 ChatGPT。查詢在唯讀的工作副本裡進行，不會改到程式。" },
      chips: { change: ["Codex SDK", "推論經轉送", "只動工作副本"], query: ["Codex SDK", "推論經轉送", "唯讀"] },
      data: { change: "src/components/OrderButton.tsx\n<no>-  className=\"btn bg-gray-700\"</no>\n<ok>+  className=\"btn bg-brand-green\"</ok>\n\nsrc/styles/mobile.css\n<ok>+  .order-btn { background: var(--brand-green); }</ok>",
              query: "$ rg -n \"OrderButton\" src\n  src/components/OrderButton.tsx:12\n  src/pages/Home.tsx:48\n$ rg -n \"api/orders\" src/components\n  OrderButton.tsx:31  <s>fetch(\"/api/orders\")</s>" },
      end: { ph: ["done", "done", "done"] },
      anim: function (tl) { phase(tl, 2, "run"); travel(tl, "slot_relay", 0.4, "推論", "var(--ai)"); travel(tl, "relay_gpt", 0.5, "推論", "var(--ai)"); travel(tl, "relay_gpt", 0.5, "回應", "var(--ai)", true); travel(tl, "slot_relay", 0.4, "回應", "var(--ai)", true); phase(tl, 2, "done", 0.6); } },

    { modes: ["change"], title: "收集差異、跑測試", where: "工作容器（沒有網路）", cam: "work", focus: [],
      text: "用可信的原始基底收集差異。有變更時，在沒有網路的容器裡跑專案的測試命令；測試寫死 LocalDB 時，系統會暫時把連線導向容器內的 SQL Server。沒有變更且 Codex 確認已符合需求時，你可以在看板查看判斷依據，群組和管理者都會收到無需修改的通知。",
      chips: ["測試沒有網路", "不信任容器內 .git", "LocalDB 自動導向"],
      data: "<k>變更</k>  2 個檔案（+2 −1）\n\n$ npm test\n  <ok>✓</ok> OrderButton 顯示品牌綠\n  <ok>✓</ok> 手機版按鈕樣式\n  <ok>✓</ok> 點擊後送出訂單\n<ok>Tests  128 passed (128)</ok>",
      end: { ph: ["done", "done", "done", "done", "done"] },
      anim: function (tl) { phase(tl, 3, "run"); phase(tl, 3, "done", 0.5); tl.fromTo(netBadge, { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: 0.3 }); phase(tl, 4, "run"); phase(tl, 4, "done", 1.6); tl.to(netBadge, { opacity: 0, duration: 0.3 }); } },

    { modes: ["query"], title: "寫成調查報告", where: "工作容器", cam: "work", focus: [],
      text: "查詢不收集差異、不跑測試，也不做獨立審查。Codex 把找到的東西寫成報告，附檔案路徑與行號；回答會遮蔽常見的機密格式。",
      chips: ["附路徑與行號", "遮蔽機密", "不開 PR"],
      data: "<s>## 先看重點</s>\n訂購按鈕是 src/components/OrderButton.tsx，\n首頁在 src/pages/Home.tsx:48 使用。\n按下後呼叫 POST /api/orders（OrderButton.tsx:31）。\n手機版用同一個元件，只在 mobile.css 調整樣式。",
      end: { ph: ["done", "done", "done", "skip", "skip", "skip"] },
      anim: function (tl) { phase(tl, 3, "skip"); phase(tl, 4, "skip"); phase(tl, 5, "skip"); tl.to({}, { duration: 2.2 }); } },

    { modes: ["change"], title: "獨立審查", where: "唯讀工作區 → 訂閱轉送 → ChatGPT", cam: "ai", focus: ["relay", "gpt"],
      text: "另一個 Codex 在唯讀的工作區重新檢查：變更符不符合需求與驗收條件、測試可不可信。不通過會自動修復一次，仍不通過就停下交給你。需要人或正式環境才能確認的項目，會列在 PR 的「待人工確認」。",
      chips: ["唯讀工作區", "自動修復 1 次", "待人工確認"],
      data: "<k>審查結果</k>  <ok>通過</ok>\n  <ok>✓</ok> 桌機與手機版按鈕為綠色\n  <ok>✓</ok> 點擊流程測試涵蓋下單\n<k>待人工確認</k>\n  · 正式環境的實際色差，合併前請目視確認",
      end: { ph: ["done", "done", "done", "done", "done", "done"] },
      anim: function (tl) { tl.fromTo(roBadge, { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: 0.3 }); phase(tl, 5, "run"); travel(tl, "slot_relay", 0.4, "審查", "var(--ai)"); travel(tl, "relay_gpt", 0.5, "審查", "var(--ai)"); travel(tl, "relay_gpt", 0.5, "通過", "var(--good)", true); travel(tl, "slot_relay", 0.4, "通過", "var(--good)", true); phase(tl, 5, "done"); tl.to(roBadge, { opacity: 0, duration: 0.3 }); } },

    { title: { change: "開 PR、回報群組", query: "把答案送回來" }, where: "app → GitHub・LINE", follow: true, focus: ["app", "gh", "line", "admin"],
      text: { change: "app 用 GitHub App 建立分支、Issue 與 PR，私訊你，也在群組回一則訊息。這兩則是 LINE 推播，會算進每月額度，群組依人數計。額度用完時訊息會排隊，群組成員打 /進度 就能用 reply token 免費取回。",
              query: "報告存到任務上、回覆到 GitHub Issue，並在群組貼出重點、私訊你。群組裡只放重點，「回覆」那則答案打「詳細」，機器人會分段貼出全文，不建任務、不用額度。" },
      chips: { change: ["GitHub App", "推播算額度", "/進度 免費取回"], query: ["GitHub Issue", "群組貼重點", "打「詳細」看全文"] },
      data: { change: "<k>GitHub</k>\n  分支  agentflow/128-order-button-green\n  <s>PR #42</s>  首頁訂購按鈕改綠色（Closes #41）\n\n<k>群組（推播，計入額度）</k>\n  「首頁訂購按鈕改綠色」已修改完成，\n  等管理者檢視後合併：…/pull/42\n\n<k>私訊你</k>\n  PR 已完成，請檢視後合併",
              query: "<k>GitHub</k>\n  <s>Issue #41</s>  回覆調查報告\n\n<k>群組（推播，計入額度）</k>\n  「訂購按鈕在哪」的查詢結果：…\n  （回覆這則打「詳細」看全文）\n\n<k>私訊你</k>\n  查詢已回覆：訂購按鈕在哪" },
      end: { slot: false, bub: ["m1", "r1", "m2", "f1"], pr: true, adm: { change: "pr", query: "answered" }, app: { change: "PR #42 等你合併", query: "已回覆" } },
      anim: function (tl, mode) {
        tl.to(slot, { opacity: 0, duration: 0.5 });
        travel(tl, "app_gh", 1.6, mode === "change" ? "PR" : "報告", "var(--fg)");
        tl.fromTo(prTag, { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: 0.35, ease: "back.out(2)" });
        travel(tl, "out_line", 1.4, "群組", "var(--line)"); showBubble(tl, "f1");
        travel(tl, "app_admin", 1.0, "私訊", "var(--line)");
        tl.call(function () { setAdmin(mode === "change" ? "pr" : "answered"); });
        status(tl, mode === "change" ? "PR #42 等你合併" : "已回覆");
      } },

    { title: { change: "由你決定合併", query: "接著問也行" }, where: { change: "GitHub → Webhook → app", query: "LINE → app" }, follow: { change: true, query: false }, focus: { change: ["admin", "gh", "tunnel", "app"], query: ["line", "app"] },
      text: { change: "你在 GitHub 審閱後合併。合併事件經 GitHub Webhook 回到 app（一樣走通道進來），看板把任務標成已合併，這次的結果也會成為之後判讀的參考。系統不會自動部署目標專案。",
              query: "在群組「回覆」那則答案輸入追問，不用再寫專案名稱。系統沿用同一個專案與分支開新的一題，原本的答案保留；接錯題時可以改引用正確的那則。" },
      chips: { change: ["人工合併", "不自動部署", "結果回寫"], query: ["引用就能追問", "沿用專案與分支", "原答案保留"] },
      data: { change: "<k>POST</k> https://固定網址/webhooks/github\n  <k>X-Hub-Signature-256:</k> sha256=…\n  action: closed, merged: <s>true</s>\n\n任務 #128 → <ok>已合併</ok>",
              query: "<k>回覆機器人的答案</k>\n  那按下去失敗時會顯示什麼？\n\n→ 新的一題，沿用 example-org/ShopWeb ← main\n  <s>收到，我接著上一題處理。</s>" },
      end: { app: { change: "已合併", query: "可以接著問" }, adm: { change: "merged", query: "answered" }, merged: { change: true, query: false } },
      anim: function (tl, mode) {
        if (mode === "change") {
          travel(tl, "admin_gh", 1.6, "合併");
          tl.call(function () { prText.textContent = "PR #42 ✓"; });
          travel(tl, "gh_hook", 1.8, "Webhook", "var(--fg)"); travel(tl, "tunnel_app", 0.4, "Webhook", "var(--fg)");
          tl.call(function () { setAdmin("merged"); });
          status(tl, "已合併");
          if (!RM) tl.to(cam, { x: 0, y: 0, w: 1600, h: 900, duration: 1.4, ease: "power3.inOut", onUpdate: applyCam }, "+=0.3");
        } else {
          travel(tl, "line_tunnel", 0.9, "追問"); travel(tl, "tunnel_app", 0.4, "追問");
          status(tl, "可以接著問");
        }
      } }
  ];

  // ---------- 狀態 ----------
  var mode = "change", scenes = [];
  function pick(v) { return v && typeof v === "object" && !Array.isArray(v) && (v.change !== undefined || v.query !== undefined) ? v[mode] : v; }
  var ADM = {
    none: ["收件匣", "var(--muted-fg)", "var(--card)", "目前沒有待處理", "", false],
    pending: ["待審核", "var(--warn)", "var(--warn-soft)", "首頁訂購按鈕改綠色", "example-org/ShopWeb", true],
    approved: ["已核准・排隊中", "var(--good)", "var(--good-soft)", "首頁訂購按鈕改綠色", "v1・王大同核准", false],
    pr: ["待你合併", "var(--info)", "var(--info-soft)", "PR #42 首頁訂購按鈕改綠色", "LINE 私訊已送達", false],
    merged: ["已合併", "var(--good)", "var(--good-soft)", "首頁訂購按鈕改綠色", "近 7 天已合併 +1", false],
    answered: ["查詢已回覆", "var(--good)", "var(--good-soft)", "訂購按鈕在哪", "LINE 私訊已送達", false]
  };
  function setAdmin(s) {
    var m = ADM[s] || ADM.none;
    admPill.t.textContent = m[0]; admPill.t.style.fill = m[1]; admPill.r.style.fill = m[2];
    var w = m[0].length * 12.6 + 20; admPill.r.setAttribute("width", w); admPill.t.setAttribute("x", 66 + w / 2);
    admTitle.textContent = m[3]; admRepo.textContent = m[4];
    op(admBtn, m[5] ? 1 : 0);
    if (hasGsap) gsap.set(admBtn, { clearProps: "transform" }); admBtn.removeAttribute("transform");
  }
  var PST = { run: ["進行中", "var(--info)", "var(--info-soft)"], done: ["完成", "var(--good)", "var(--good-soft)"], skip: ["查詢不做", "var(--muted-fg)", "var(--card)"] };
  function setPhaseNow(i, s) {
    var p = phases[i];
    p.bar.setAttribute("width", s === "done" ? 398 : 0);
    while (p.stG.firstChild) p.stG.removeChild(p.stG.firstChild);
    if (PST[s]) pill(1364, p.y + 8, PST[s][0], PST[s][1], PST[s][2], p.stG, { anchor: "end" });
    op(p.g, s === "skip" ? 0.5 : 1);
  }
  function resetT(n) { if (hasGsap) gsap.set(n, { clearProps: "transform" }); n.removeAttribute("transform"); }
  function applyState(st) {
    Object.keys(bubbles).forEach(function (k) { op(bubbles[k], st.bub.indexOf(k) >= 0 ? 1 : 0); resetT(bubbles[k]); });
    op(tri, st.tri ? 1 : 0); op(triSkel, 0);
    TRI[mode].forEach(function (kv, i) { triRows[i].k.textContent = kv[0]; triRows[i].v.textContent = kv[1]; op(triRows[i].g, i < (st.triRows || 0) ? 1 : 0); resetT(triRows[i].g); });
    op(slot, st.slot ? 1 : 0); resetT(slot);
    op(netBadge, 0); op(roBadge, 0); op(noEntry, 0); op(cursor, 0);
    for (var i = 0; i < 6; i++) setPhaseNow(i, st.ph[i] || "idle");
    op(prTag, st.pr ? 1 : 0); resetT(prTag);
    prText.textContent = mode === "change" ? (st.merged ? "PR #42 ✓" : "PR #42") : "Issue #41";
    setAdmin(st.adm);
    appStatus.textContent = st.app || "等待訊息";
    op(ring, 0); op(packet, 0); hideTail();
    Object.keys(trailEls).forEach(function (k) { trailEls[k].style.opacity = 0; flowEls[k].style.opacity = 0; });
  }
  var initial = { bub: [], tri: false, triRows: 0, slot: false, ph: [], pr: false, adm: "none", app: "等待訊息", merged: false };
  function stateBefore(i) {
    var st = JSON.parse(JSON.stringify(initial));
    for (var k = 0; k < i; k++) { var e = scenes[k].end || {}; Object.keys(e).forEach(function (key) { st[key] = pick(e[key]); }); }
    return st;
  }

  // ---------- 動畫工具 ----------
  var used = [];
  function touch(k) { used.push(k); }
  var PATH_NODES = { line_tunnel: ["line", "tunnel"], tunnel_app: ["tunnel", "app"], app_db: ["app", "db"], db_emb: ["db", "emb"], app_emb: ["app", "emb"], out_line: ["app", "line"], app_runner: ["app", "runner"], runner_slot: ["runner", "slot"], slot_relay: ["slot", "relay"], relay_gpt: ["relay", "gpt"], app_admin: ["app", "admin"], gh_slot: ["gh", "slot"], slot_egress: ["slot", "egress"], egress_pkg: ["egress", "pkg"], egress_bad: ["egress"], app_gh: ["app", "gh"], gh_hook: ["gh", "tunnel", "app"], admin_gh: ["admin", "gh"] };
  var follow = false;
  function travel(tl, id, dur, label, color, rev, at) {
    touch("p:" + id);
    dur = dur * 0.78;
    if (follow && !RM) { var fr = frameOf(["p:" + id].concat(PATH_NODES[id] || [])); tl.to(cam, { x: fr[0], y: fr[1], w: fr[2], h: fr[3], duration: 0.8, ease: "power3.inOut", onUpdate: applyCam }, at); at = undefined; }
    var o = { t: 0 }, c = color || "var(--brand)", trail = trailEls[id], flow = flowEls[id], L = pathEls[id].getTotalLength();
    tl.call(function () {
      setPacket(label, c); placeAt(id, 0, rev); op(packet, 1);
      trail.style.stroke = c; trail.style.strokeDasharray = L; trail.style.strokeDashoffset = rev ? -L : L; trail.style.opacity = 0.85;
      flow.style.stroke = c; flow.style.opacity = 0.9;
    }, null, at);
    tl.fromTo(pCore, { attr: { r: 6 } }, { attr: { r: 15 }, duration: 0.22, ease: "back.out(2.5)" });
    tl.to(o, { t: 1, duration: RM ? 0.05 : dur, ease: "power2.inOut", onUpdate: function () {
      placeAt(id, o.t, rev); trail.style.strokeDashoffset = (rev ? -1 : 1) * L * (1 - o.t);
    } }, "<");
    tl.call(hideTail);
    tl.to([trail, flow], { opacity: 0, duration: 0.5 }, ">-0.02");
    tl.set(packet, { opacity: 0 }, "<");
  }
  function status(tl, text) {
    tl.call(function () { appStatus.textContent = text; });
    tl.fromTo(appDot, { attr: { r: 9 } }, { attr: { r: 5 }, duration: 0.5, ease: "power2.out" });
  }
  function showBubble(tl, id) {
    touch("line");
    var b = bubbles[id]; if (!b) return;
    tl.fromTo(b, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.4, ease: "back.out(1.6)" });
  }
  function fadeIn(tl, g) { if (g === tri) touch("tri"); tl.fromTo(g, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.45 }); }
  function phase(tl, i, s, hold) {
    touch("slot");
    if (s === "run") {
      tl.call(function () { setPhaseNow(i, "run"); });
      tl.fromTo(phases[i].bar, { attr: { width: 0 } }, { attr: { width: 398 }, duration: RM ? 0.05 : 0.9, ease: "power1.out" });
    } else {
      if (hold) tl.to({}, { duration: hold });
      tl.call(function () { setPhaseNow(i, s); });
    }
  }
  function countdown(tl, dur) {
    touch("app");
    var o = { v: 60 };
    tl.set(ring, { opacity: 1 });
    tl.to(o, { v: 0, duration: RM ? 0.05 : dur, ease: "none", onUpdate: function () { ringText.textContent = Math.ceil(o.v); ringArc.setAttribute("stroke-dashoffset", 113.1 * (1 - o.v / 60)); } });
    tl.to(ring, { opacity: 0, duration: 0.4 });
  }
  var RECT = { slot: [960, 240, 430, 380], tri: [960, 240, 430, 200] };
  function rectOf(k) {
    if (RECT[k]) return RECT[k];
    if (C[k]) return [C[k].x, C[k].y, C[k].w, C[k].h];
    if (k.indexOf("p:") === 0) { var b = pathEls[k.slice(2)].getBBox(); return [b.x, b.y, b.width, b.height]; }
    return null;
  }
  // 把這一步用到的元件與連線框起來，四周留白，補成 16:9；不切到卡片。
  function frameOf(keys) {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    keys.forEach(function (k) { var r = rectOf(k); if (!r) return; x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[0] + r[2]); y1 = Math.max(y1, r[1] + r[3]); });
    if (x0 > x1) return [0, 0, 1600, 900];
    var pad = 48, w = x1 - x0 + pad * 2, h = y1 - y0 + pad * 2;
    if (w / h > 16 / 9) h = w * 9 / 16; else w = h * 16 / 9;
    if (w < 820) { w = 820; h = w * 9 / 16; }
    if (w >= 1560) return [0, 0, 1600, 900];
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    var x = Math.max(-20, Math.min(1620 - w, cx - w / 2)), y = Math.max(-20, Math.min(920 - h, cy - h / 2));
    return [x, y, w, h];
  }
  function camTo(tl, r, dur) {
    if (RM) { tl.call(function () { cam.x = r[0]; cam.y = r[1]; cam.w = r[2]; cam.h = r[3]; applyCam(); }, null, 0); return; }
    tl.to(cam, { x: r[0], y: r[1], w: r[2], h: r[3], duration: dur, ease: "power3.inOut", onUpdate: applyCam }, 0);
  }
  function focusOn(tl, ids) {
    Object.keys(nodes).forEach(function (id) {
      var on = ids.indexOf(id) >= 0;
      nodes[id].g.classList.toggle("on", on);
      tl.to(nodes[id].g, { opacity: !ids.length || on ? 1 : 0.28, duration: 0.5 }, 0);
    });
  }

  // ---------- 播放器 ----------
  var cur = 0, tl = null, playing = false, speed = 1, timer = null;
  var trackEl = document.getElementById("track"), chapsEl = document.getElementById("chaps"), ticks = [], chaps = [];
  var lower = document.getElementById("lower");
  function buildNav() {
    trackEl.innerHTML = ""; chapsEl.innerHTML = ""; ticks = []; chaps = [];
    scenes.forEach(function (s, i) {
      var b = document.createElement("button");
      b.className = "tick"; b.type = "button"; b.title = (i + 1) + ". " + pick(s.title); b.setAttribute("aria-label", "第 " + (i + 1) + " 步：" + pick(s.title));
      b.appendChild(document.createElement("i"));
      b.addEventListener("click", function () { hideCover(); go(i, playing); });
      trackEl.appendChild(b); ticks.push(b);
      var li = document.createElement("li"), cb = document.createElement("button");
      cb.className = "chap"; cb.type = "button";
      var n = document.createElement("span"); n.className = "n"; n.textContent = i + 1;
      cb.appendChild(n); cb.appendChild(document.createTextNode(pick(s.title)));
      cb.addEventListener("click", function () { hideCover(); go(i, playing); document.getElementById("player").scrollIntoView({ behavior: RM ? "auto" : "smooth", block: "start" }); });
      li.appendChild(cb); chapsEl.appendChild(li); chaps.push(cb);
    });
  }
  function fmt(src) {
    return src.split("\n").map(function (l) {
      return '<span class="ln">' + (l
        .replace(/<k>/g, '<span class="k">').replace(/<\/k>/g, "</span>")
        .replace(/<s>/g, '<span class="s">').replace(/<\/s>/g, "</span>")
        .replace(/<ok>/g, '<span class="ok">').replace(/<\/ok>/g, "</span>")
        .replace(/<no>/g, '<span class="no">').replace(/<\/no>/g, "</span>") || " ") + "</span>";
    }).join("");
  }
  function caption(i, animate) {
    var s = scenes[i], tot = String(scenes.length).padStart(2, "0"), n = String(i + 1).padStart(2, "0");
    document.getElementById("cap-idx").textContent = "步驟 " + n + " / " + tot;
    document.getElementById("cap-where").textContent = ent(pick(s.where));
    document.getElementById("clock").textContent = n + " / " + tot;
    document.getElementById("cap-title").textContent = pick(s.title);
    var text = ent(pick(s.text));
    document.getElementById("cap-text").textContent = text;
    var chips = document.getElementById("cap-chips"); chips.innerHTML = "";
    (pick(s.chips) || []).forEach(function (t) { var c = document.createElement("span"); c.className = "badge"; c.textContent = t; chips.appendChild(c); });
    var pre = document.getElementById("cap-data"); pre.innerHTML = fmt(ent(pick(s.data)));
    document.getElementById("lower-num").textContent = n;
    document.getElementById("lower-title").textContent = pick(s.title);
    document.getElementById("lower-text").textContent = text.split("。")[0] + "。";
    ticks.forEach(function (b, k) { b.firstChild.style.width = k < i ? "100%" : "0"; });
    chaps.forEach(function (b, k) { b.classList.toggle("done", k < i); if (k === i) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current"); });
    if (animate && hasGsap && !RM) {
      gsap.fromTo(lower, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.45, ease: "power2.out" });
      gsap.fromTo(pre.children, { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: 0.25, stagger: 0.06, delay: 0.2 });
    }
  }
  function go(i, autoplay) {
    clearTimeout(timer);
    if (tl) tl.kill();
    cur = Math.max(0, Math.min(scenes.length - 1, i));
    var s = scenes[cur];
    applyState(stateBefore(cur));
    caption(cur, autoplay);
    if (!hasGsap) { applyState(stateBefore(cur + 1)); return; }
    tl = gsap.timeline({ paused: true,
      onUpdate: function () { if (ticks[cur]) ticks[cur].firstChild.style.width = (tl.progress() * 100) + "%"; },
      onComplete: function () {
        applyState(stateBefore(cur + 1));
        if (playing) timer = setTimeout(function () { if (cur < scenes.length - 1) go(cur + 1, true); else setPlaying(false); }, 350 / speed);
      } });
    var focus = pick(s.focus) || [];
    focusOn(tl, focus);
    tl.to({}, { duration: RM ? 0.1 : 0.45 });
    used = focus.slice();
    follow = !!pick(s.follow);
    s.anim(tl, mode);
    follow = false;
    if (!pick(s.follow)) camTo(tl, frameOf(used), 1.1);
    tl.to({}, { duration: RM ? 2.5 : 1.4 });
    tl.timeScale(speed);
    if (autoplay) tl.play(); else tl.progress(1).pause();
  }
  var playIco = document.getElementById("play-ico").querySelector("use");
  function setPlaying(p) {
    playing = p;
    playIco.setAttribute("href", p ? "#i-pause" : "#i-play");
    document.getElementById("play").setAttribute("aria-label", p ? "暫停" : "播放");
    document.getElementById("live").classList.toggle("on", p);
    document.getElementById("live-text").textContent = p ? "播放中" : "已暫停";
  }
  function hideCover() { document.getElementById("cover").hidden = true; }
  function togglePlay() {
    hideCover();
    if (playing) { setPlaying(false); clearTimeout(timer); if (tl) tl.pause(); return; }
    setPlaying(true);
    if (tl && tl.progress() < 1) tl.play(); else go(cur, true);
  }
  document.getElementById("bigplay").addEventListener("click", function () { hideCover(); setPlaying(true); go(0, true); });
  document.getElementById("play").addEventListener("click", togglePlay);
  document.getElementById("prev").addEventListener("click", function () { hideCover(); go(cur - 1, playing); });
  document.getElementById("next").addEventListener("click", function () { hideCover(); go(cur + 1, playing); });
  var speeds = [1, 1.5, 2, 0.75], si = 0;
  document.getElementById("speed").addEventListener("click", function (e) { si = (si + 1) % speeds.length; speed = speeds[si]; e.currentTarget.textContent = speed + "×"; e.currentTarget.setAttribute("aria-label", "播放速度 " + speed + "×"); if (tl) tl.timeScale(speed); });
  document.getElementById("full").addEventListener("click", function () {
    var p = document.getElementById("player");
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (p.requestFullscreen) { var r = p.requestFullscreen(); if (r && r.catch) r.catch(function () {}); }
    } catch (e) { /* 部分檢視器不支援全螢幕 */ }
  });
  document.addEventListener("keydown", function (e) {
    if (e.target.closest && e.target.closest("button") && (e.key === " " || e.key === "Enter")) return;
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key === "ArrowRight") { hideCover(); go(cur + 1, playing); }
    else if (e.key === "ArrowLeft") { hideCover(); go(cur - 1, playing); }
  });
  function setMode(m) {
    mode = m;
    document.getElementById("mode-change").setAttribute("aria-pressed", m === "change");
    document.getElementById("mode-query").setAttribute("aria-pressed", m === "query");
    document.getElementById("player-title").textContent = m === "change" ? "修改程式的完整流程" : "查詢問題的完整流程";
    document.getElementById("player-desc").textContent = m === "change" ? "「把首頁的訂購按鈕改成綠色」" : "「訂購按鈕在哪個元件？」";
    scenes = ALL.filter(function (s) { return !s.modes || s.modes.indexOf(m) >= 0; });
    buildBubbles(m); buildNav(); go(0, playing);
  }
  document.getElementById("mode-change").addEventListener("click", function () { setMode("change"); });
  document.getElementById("mode-query").addEventListener("click", function () { setMode("query"); });

  // 靜止畫面：整張架構圖、封面卡、第一步的旁白
  setMode("change");
  if (tl) tl.kill();
  tl = null;
  cam.x = 0; cam.y = 0; cam.w = 1600; cam.h = 900; applyCam();
  Object.keys(nodes).forEach(function (id) { nodes[id].g.style.opacity = 1; nodes[id].g.classList.remove("on"); });
  applyState(stateBefore(0));

  if (params.get("embed") === "1") {
    document.documentElement.classList.add("embed");
    var report = function () {
      parent.postMessage({ type: "agentflow-flow-height", height: document.documentElement.scrollHeight }, location.origin);
    };
    new ResizeObserver(report).observe(document.body);
    report();
    addEventListener("message", function (e) {
      if (e.origin === location.origin && e.data && e.data.type === "agentflow-flow-theme") setTheme(e.data.theme);
    });
  }
