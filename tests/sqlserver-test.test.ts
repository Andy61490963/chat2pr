import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_WORKER_IMAGE,
  ENVIRONMENT_EXIT,
  ENVIRONMENT_MARK,
  SQLSERVER_WORKER_IMAGE,
  detectSqlServer,
  environmentFailure,
  selfManagedSqlServer,
  sqlServerPlan,
  sqlServerTestCommand,
  testEnvironment,
} from "../server/sqlserver-test.js";
import {
  redirectFiles,
  restoreFiles,
  rewriteLocalDb,
} from "../worker/mssql/sqlserver.mjs";

const testProject = (extra = "") => `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.2" />
    ${extra}
  </ItemGroup>
</Project>`;
const sqlClient =
  '<PackageReference Include="Microsoft.Data.SqlClient" Version="5.2.2" />';

describe("判斷測試是否需要 SQL Server", () => {
  it("測試專案直接使用 SQL Server 用戶端套件", () => {
    expect(
      detectSqlServer({
        "tests/Orders.Tests/Orders.Tests.csproj": testProject(sqlClient),
      }),
    ).toEqual([
      {
        path: "tests/Orders.Tests/Orders.Tests.csproj",
        quote: '<PackageReference Include="Microsoft.NET.Test.Sdk"',
      },
      {
        path: "tests/Orders.Tests/Orders.Tests.csproj",
        quote: '<PackageReference Include="Microsoft.Data.SqlClient"',
      },
    ]);
  });

  it("測試專案參照的專案使用 EF Core SqlServer 也算", () => {
    const reasons = detectSqlServer({
      "src/Loader/Loader.csproj":
        '<Project><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="8.0.10" /></ItemGroup></Project>',
      "tests/Loader.Tests/Loader.Tests.csproj": testProject(
        '<ProjectReference Include="..\\..\\src\\Loader\\Loader.csproj" />',
      ),
    });
    expect(reasons.map((r) => r.path)).toEqual([
      "tests/Loader.Tests/Loader.Tests.csproj",
      "src/Loader/Loader.csproj",
    ]);
    expect(reasons[1].quote).toContain(
      "Microsoft.EntityFrameworkCore.SqlServer",
    );
  });

  it("CI 準備 SQL Server 服務或 LocalDB", () => {
    expect(
      detectSqlServer({
        ".github/workflows/test.yml":
          "services:\n  sql:\n    image: mcr.microsoft.com/mssql/server:2022-latest\n",
      }),
    ).toEqual([
      {
        path: ".github/workflows/test.yml",
        quote: "mcr.microsoft.com/mssql/server:2022-latest",
      },
    ]);
    expect(
      detectSqlServer({
        ".github/workflows/ci.yml": "- run: sqllocaldb start MSSQLLocalDB",
      }),
    ).toHaveLength(1);
  });

  it("沒有測試用到 SQL Server 時不判定需要", () => {
    expect(
      detectSqlServer({
        // 只有產品專案用到、沒有測試專案參照它。
        "src/Api/Api.csproj": `<Project>${sqlClient}</Project>`,
        "tests/Unit/Unit.csproj": testProject(),
        "package.json": '{"scripts":{"test":"vitest"}}',
        // 中央套件版本只宣告版本，不代表有專案使用。
        "Directory.Packages.props":
          '<Project><ItemGroup><PackageVersion Include="Microsoft.Data.SqlClient" Version="5.2.2" /></ItemGroup></Project>',
      }),
    ).toEqual([]);
  });
});

describe("選用映像與管理者覆寫", () => {
  const needs = { "t/T.csproj": testProject(sqlClient) };
  it("需要時預設映像改用 SQL Server 映像；不需要的專案不換成較大的映像", () => {
    expect(sqlServerPlan({ image: DEFAULT_WORKER_IMAGE }, needs)).toMatchObject(
      { image: SQLSERVER_WORKER_IMAGE, source: "detected" },
    );
    expect(
      sqlServerPlan(
        { image: DEFAULT_WORKER_IMAGE },
        { "t/T.csproj": testProject() },
      ),
    ).toBeNull();
  });
  it("管理者可一律提供或不提供；自訂映像不自動更換", () => {
    expect(
      sqlServerPlan(
        { image: DEFAULT_WORKER_IMAGE, sql_server: "never" },
        needs,
      ),
    ).toBeNull();
    expect(
      sqlServerPlan({ image: DEFAULT_WORKER_IMAGE, sql_server: "always" }, {}),
    ).toMatchObject({ image: SQLSERVER_WORKER_IMAGE, source: "admin" });
    expect(sqlServerPlan({ image: "team-worker:custom" }, needs)).toBeNull();
    expect(
      sqlServerPlan({ image: "team-worker:custom", sql_server: "always" }, {}),
    ).toMatchObject({ image: "team-worker:custom" });
  });
  it("專案腳本自己啟動 SQL Server 時自動模式不接手，照專案腳本跑；管理者選一律提供仍提供", () => {
    // 驗收時的情況：測試腳本自己啟動 sqlservr，系統接手後 AI 給不出測試命令。
    const own = {
      ...needs,
      "scripts/test-isolated.mjs":
        "spawn('/opt/mssql/bin/sqlservr', [], { env });",
    };
    expect(selfManagedSqlServer(own)).toMatchObject({
      path: "scripts/test-isolated.mjs",
    });
    expect(sqlServerPlan({ image: SQLSERVER_WORKER_IMAGE }, own)).toBeNull();
    expect(
      sqlServerPlan(
        { image: SQLSERVER_WORKER_IMAGE, sql_server: "always" },
        own,
      ),
    ).toMatchObject({ source: "admin" });
    // CI 與文件提到 sqlservr 不算專案自己啟動。
    expect(
      selfManagedSqlServer({
        ".github/workflows/ci.yml": "run: /opt/mssql/bin/sqlservr &",
        "README.md": "需要 sqlservr",
      }),
    ).toBeNull();
  });
});

describe("測試命令與環境問題回報", () => {
  const sqlServer = {
    image: SQLSERVER_WORKER_IMAGE,
    source: "detected" as const,
    reasons: [{ path: "t/T.csproj", quote: "Microsoft.Data.SqlClient" }],
  };
  it("只在需要 SQL Server 時外包測試命令，保留原命令的引號", () => {
    expect(sqlServerTestCommand({}, "dotnet test")).toBe("dotnet test");
    const wrapped = sqlServerTestCommand(
      { sqlServer },
      "dotnet test --filter 'Category=Db'",
    );
    expect(wrapped).toContain(
      "exec agentflow-sqlserver run -- sh -c 'dotnet test --filter '\\''Category=Db'\\'''",
    );
    expect(wrapped).toContain(`exit ${ENVIRONMENT_EXIT}`);
    expect(
      sqlServerTestCommand(
        { sqlServer, dataSource: "snapshot" },
        "dotnet test",
      ),
    ).toContain("agentflow-sqlserver run --snapshot --");
    expect(() => sqlServerTestCommand({ sqlServer }, "x".repeat(7900))).toThrow(
      "測試命令過長",
    );
  });

  it("SQL Server 起不來時標示為測試環境問題並列出跳過的測試", () => {
    const stdout = `${ENVIRONMENT_MARK}{"ok":false,"stage":"start","reason":"SQL Server 在 150 秒內沒有就緒。"}\n`;
    const message = environmentFailure(
      { sqlServer, test: "dotnet test --no-restore" },
      { exitCode: ENVIRONMENT_EXIT, stdout, stderr: "" },
    );
    expect(message).toBe(
      "測試環境問題（不是程式沒過）：容器內的 SQL Server 沒有啟動成功。原因：SQL Server 在 150 秒內沒有就緒。\n已跳過的測試：測試命令「dotnet test --no-restore」整個沒有執行；需要 SQL Server 的依據：t/T.csproj。",
    );
    // 一般測試失敗、沒有 SQL Server 的設定都照原本方式處理。
    expect(
      environmentFailure(
        { sqlServer, test: "dotnet test" },
        { exitCode: 1, stdout, stderr: "" },
      ),
    ).toBeNull();
    expect(
      environmentFailure(
        { test: "dotnet test" },
        { exitCode: ENVIRONMENT_EXIT, stdout, stderr: "" },
      ),
    ).toBeNull();
    expect(
      testEnvironment(`${ENVIRONMENT_MARK}{"ok":true,"redirected":["a.json"]}`),
    ).toEqual({ ok: true, redirected: ["a.json"] });
  });
});

describe("LocalDB 連線改寫", () => {
  const password = "Af1!fictional";
  const target = `127.0.0.1,1433;User ID=sa;Password=${password};TrustServerCertificate=True`;
  it("JSON、C# 逐字字串與 XML 設定中的 LocalDB 都導向容器內 SQL Server", () => {
    const json = rewriteLocalDb(
      '{"ConnectionStrings":{"Main":"Server=(localdb)\\\\MSSQLLocalDB;Database=Orders;Trusted_Connection=True;MultipleActiveResultSets=true","Other":"Server=prod.example.test;Database=X"}}',
      password,
    );
    expect(json.text).toBe(
      `{"ConnectionStrings":{"Main":"Server=${target};Database=Orders;Trusted_Connection=False;MultipleActiveResultSets=true","Other":"Server=prod.example.test;Database=X"}}`,
    );
    expect(json).toMatchObject({ count: 1, databases: ["Orders"] });
    const cs = rewriteLocalDb(
      'const string A = @"Data Source=(localdb)\\MSSQLLocalDB;Initial Catalog=Billing;Integrated Security=True";',
      password,
    );
    expect(cs.text).toBe(
      `const string A = @"Data Source=${target};Initial Catalog=Billing;Integrated Security=False";`,
    );
    const xml = rewriteLocalDb(
      '<add name="Main" connectionString="Server=(LocalDB)\\.\\Shared;AttachDbFilename=|DataDirectory|\\Legacy.mdf;Integrated Security=SSPI" />',
      password,
    );
    expect(xml.text).toBe(
      `<add name="Main" connectionString="Server=${target};Integrated Security=False;Initial Catalog=Legacy" />`,
    );
    expect(xml.databases).toEqual(["Legacy"]);
  });

  it("沒有 LocalDB 的內容原樣保留", () => {
    const text = '{"Main":"Server=db.example.test;Database=X"}';
    expect(rewriteLocalDb(text, password)).toEqual({
      text,
      count: 0,
      databases: [],
    });
  });

  describe("備份與還原", () => {
    let root = "";
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
    it("改寫前先備份，還原後位元組完全相同；建置產物目錄不改", () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "localdb-"));
      const state = path.join(root, "obj", "agentflow-sqlserver");
      const settings = path.join(root, "tests", "appsettings.json");
      fs.mkdirSync(path.dirname(settings), { recursive: true });
      const original = Buffer.from(
        '﻿{\r\n  "Main": "Server=(localdb)\\\\MSSQLLocalDB;Database=Orders;Trusted_Connection=True"\r\n}\r\n',
      );
      fs.writeFileSync(settings, original);
      fs.mkdirSync(path.join(root, "bin"));
      fs.writeFileSync(
        path.join(root, "bin", "appsettings.json"),
        "Server=(localdb)\\MSSQLLocalDB",
      );
      const result = redirectFiles(root, state, password);
      expect(result).toEqual({
        files: [path.join("tests", "appsettings.json")],
        databases: ["Orders"],
      });
      expect(fs.readFileSync(settings, "utf8")).toContain("127.0.0.1,1433");
      expect(
        fs.readFileSync(path.join(root, "bin", "appsettings.json"), "utf8"),
      ).toContain("(localdb)");
      expect(restoreFiles(root, state)).toEqual([
        path.join("tests", "appsettings.json"),
      ]);
      expect(fs.readFileSync(settings).equals(original)).toBe(true);
      expect(fs.existsSync(state)).toBe(false);
    });
  });
});
