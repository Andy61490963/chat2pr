import { describe, expect, it } from "vitest";
import { redact } from "../server/policy.js";
import { safeDetail } from "../server/observation.js";
import { phaseEndEvents } from "../server/test-failures.js";
import { failureDigest, keyErrorLines } from "../server/failure.js";

// 虛構帳密，只用英數字。
const user = "demoUser";
const pass = "demoPass123";

const leaky: [string, string, string[]][] = [
  ["PostgreSQL 網址", `連線失敗 postgres://${user}:${pass}@db.demo.test:5432/demo_shop`, [user, "db.demo.test:5432/demo_shop"]],
  ["postgresql 網址", `postgresql://${user}:${pass}@db.demo.test/demo_shop?sslmode=require`, [user, "db.demo.test/demo_shop"]],
  ["MySQL 網址", `mysql://${user}:${pass}@mysql.demo.test:3306/shop`, [user, "mysql.demo.test:3306/shop"]],
  ["MongoDB SRV 網址", `mongodb+srv://${user}:${pass}@cluster0.demo.test/shop?retryWrites=true`, [user, "cluster0.demo.test/shop"]],
  ["Redis 只有密碼", `redis://:${pass}@cache.demo.test:6379/0`, ["cache.demo.test:6379/0"]],
  ["AMQP 網址", `amqp://${user}:${pass}@mq.demo.test/demoVhost`, [user, "mq.demo.test/demoVhost"]],
  ["JDBC 網址", `jdbc:postgresql://db.demo.test/demo_shop?user=${user}&password=${pass}`, [user, "db.demo.test/demo_shop"]],
  ["引號內的網址", `"ConnectionString": "postgres://${user}:${pass}@db.demo.test/demo_shop"`, [user, "db.demo.test/demo_shop"]],
  ["ADO.NET 連線字串", `Server=sql.demo.test,1433;Database=DemoShop;User Id=${user};Password=${pass};TrustServerCertificate=True`, ["Server=sql.demo.test,1433", "Database=DemoShop", `User Id=${user}`, "TrustServerCertificate=True"]],
  ["Npgsql 連線字串", `Host=db.demo.test;Port=5432;Database=demo_shop;Username=${user};Password=${pass}`, ["Host=db.demo.test", "Database=demo_shop", `Username=${user}`]],
  ["ODBC 大括號密碼", `Driver={ODBC Driver 18 for SQL Server};Server=sql.demo.test;Uid=${user};Pwd={${pass}};`, ["Server=sql.demo.test", `Uid=${user}`]],
  ["小寫 pwd", `server=sql.demo.test;uid=${user};pwd=${pass}`, ["server=sql.demo.test"]],
  ["JSON 密碼欄位", `{"user":"${user}","password":"${pass}"}`, [user]],
  ["跳脫後的 JSON", `{\\"password\\":\\"${pass}\\"}`, []],
  ["YAML 密碼欄位", `  password: ${pass}\n  host: db.demo.test`, ["host: db.demo.test"]],
  ["Authorization Basic", `Authorization: Basic ${pass}`, ["Authorization: Basic"]],
  ["Bearer 權杖", `curl -H "Authorization: Bearer ${pass}"`, ["Bearer"]],
  ["查詢參數權杖", `GET /api?access_token=${pass}&page=2`, ["page=2"]],
  ["JSON auth 欄位", `{"auth":"${pass}"}`, []],
  ["auth 參數", `redis-cli auth=${pass}`, ["redis-cli"]],
  ["JWT",`token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vVXNlciJ9.${pass}`, []],
  ["GitHub 權杖", `ghp_${pass}demoPass123demo`, []],
  ["OpenAI 金鑰", `sk-proj-${pass}${pass}`, []],
  ["AWS 存取金鑰", `AKIA${"DEMOPASS1234567X"}`, []],
  ["Slack 權杖", `xoxb-123456789012-${pass}`, []],
  ["私鑰", `-----BEGIN OPENSSH PRIVATE KEY-----\n${pass}\n-----END OPENSSH PRIVATE KEY-----`, []],
];

const secretOf = (name: string) => (name === "AWS 存取金鑰" ? "DEMOPASS1234567X" : pass);

describe("遮蔽各種格式的帳密：密碼不出現，主機與資料庫仍看得懂", () => {
  for (const [name, input, kept] of leaky) {
    it(name, () => {
      for (const masked of [redact(input), safeDetail(input)]) {
        expect(masked).not.toContain(secretOf(name));
        for (const k of kept) expect(redact(input)).toContain(k);
      }
    });
  }

  it("遮蔽可以重複套用，結果不變", () => {
    for (const [, input] of leaky) expect(redact(redact(input))).toBe(redact(input));
  });
});

describe("不含機密的訊息不被破壞", () => {
  const plain = [
    "https://github.com/demo/shop/pull/2",
    "http://localhost:5173/projects?tab=2",
    "ssh://git@github.com/demo/shop.git",
    "SyntaxError: Unexpected token: '<' in JSON at position 0",
    "expected 5 to equal 3",
    "Server=sql.demo.test;Database=DemoShop;User Id=demoUser;TrustServerCertificate=True",
    "max_tokens=1000 temperature=0",
    "Discord 應用程式 ID 123456789012345678",
    "示範專案的登入頁：密碼欄位顯示錯誤",
    "Assert.Equal() Failure: Values differ",
    "Demo.Shop.Tests.LoginTests.Password_ShouldBeRequired [FAIL]",
    "auth: 改用 OAuth 登入",
  ];
  for (const text of plain)
    it(text, () => {
      expect(redact(text)).toBe(text);
    });
});

describe("過長輸入不會因正規表示式回溯而卡住", () => {
  const n = 200_000;
  const inputs = {
    英文長字: "a".repeat(n),
    重複協定: "postgres://".repeat(n / 11),
    重複冒號: "a:".repeat(n / 2),
    重複鍵名: "password=".repeat(n / 9),
    重複鍵名無值: "Password=;".repeat(n / 10),
    重複私鑰開頭: "-----BEGIN RSA PRIVATE KEY-----".repeat(n / 31),
    重複小數點: "a.".repeat(n / 2),
    重複權杖開頭: "Bearer ".repeat(n / 7),
    沒有結尾的引號: `password="${"a".repeat(n)}`,
    重複引號鍵名: `"password":"`.repeat(n / 12),
    重複網址開頭: "://a:b".repeat(n / 6),
    長網址: `postgres://${"u".repeat(n)}:${pass}@db.demo.test/x`,
  };
  for (const [name, input] of Object.entries(inputs))
    it(name, () => {
      const started = performance.now();
      redact(input);
      safeDetail(input);
      expect(performance.now() - started).toBeLessThan(1500);
    });
});

describe("出口先遮蔽再截斷，截斷處不留下半段密碼", () => {
  const url = `postgres://${user}:${pass}@db.demo.test:5432/demo_shop`;
  it("階段結束事件只留輸出結尾時，切在網址中間也不外露", () => {
    // 只留最後 4000 字元時，保留的部分從網址的使用者名稱中間開始（「User:demoPass123@…」）。
    const stdout = `${"x".repeat(5000)}${url}${"y".repeat(4015 - url.length)}`;
    expect(stdout.slice(-4000).startsWith(`User:${pass}@`)).toBe(true);
    const events = phaseEndEvents("test", { exitCode: 1, stdout, stderr: "" });
    for (const e of events) expect(safeDetail(e.detail)).not.toContain(pass);
  });
  it("失敗摘要與錯誤行", () => {
    const output = `Npgsql.NpgsqlException: 無法連線 ${url}\nHost=db.demo.test;Password=${pass}`;
    expect(failureDigest(output)).not.toContain(pass);
    expect(keyErrorLines(output)).not.toContain(pass);
  });
});
