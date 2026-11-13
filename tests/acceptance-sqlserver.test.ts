import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Containers } from "../server/containers.js";
import {
  ENVIRONMENT_EXIT,
  environmentFailure,
  sqlServerTestCommand,
  testEnvironment,
} from "../server/sqlserver-test.js";

// 需要含 agentflow-sqlserver 的 SQL Server 工作映像，而且要下載 NuGet 套件、啟動 SQL Server，
// 跑一次約需數分鐘；預設略過。用法：
// ACCEPTANCE_MSSQL_IMAGE=<以 worker/mssql.Dockerfile 建立的臨時標籤> npx vitest run tests/acceptance-sqlserver.test.ts
const image = process.env.ACCEPTANCE_MSSQL_IMAGE;
const sqlServer = {
  image: image ?? "",
  source: "detected" as const,
  reasons: [
    {
      path: "tests/Fictional.Orders.IntegrationTests/Fictional.Orders.IntegrationTests.csproj",
      quote: '<PackageReference Include="Microsoft.Data.SqlClient"',
    },
  ],
};

describe.skipIf(!image)(
  "測試階段的 SQL Server 與 LocalDB 導向（實際容器）",
  () => {
    it("寫死 LocalDB 的虛構整合測試在無網路容器內連上 SQL Server 並通過，結束後專案檔案不變", async () => {
      const c = new Containers(),
        id = randomUUID();
      try {
        await c.prepare(
          id,
          image!,
          execFileSync("tar", [
            "-cf",
            "-",
            "-C",
            "tests/fixtures",
            "localdb-project",
          ]),
        );
        const restore = await c.phase(
          id,
          image!,
          ["sh", "-c", "dotnet restore Fictional.Orders.sln"],
          "line-agentflow_install",
          undefined,
          600000,
        );
        expect(restore.exitCode, restore.stdout + restore.stderr).toBe(0);
        const test = "dotnet test Fictional.Orders.sln --no-restore";
        // 對照：不導向時，Linux 容器內的 LocalDB 連線一定失敗。
        const direct = await c.phase(
          id,
          image!,
          ["sh", "-c", test],
          "none",
          undefined,
          600000,
        );
        expect(direct.exitCode).not.toBe(0);
        expect(direct.stdout + direct.stderr).toMatch(
          /LocalDB is not supported/,
        );
        const result = await c.phase(
          id,
          image!,
          [
            "sh",
            "-c",
            sqlServerTestCommand({ sqlServer, dataSource: "none" }, test),
          ],
          "none",
          undefined,
          900000,
        );
        const output = result.stdout + result.stderr;
        expect(result.exitCode, output.slice(-4000)).toBe(0);
        expect(output).toMatch(/Passed!\s+-\s+Failed:\s+0,\s+Passed:\s+3/);
        const report = testEnvironment(result.stdout)!;
        expect(report.ok).toBe(true);
        expect(report.redirected).toEqual([
          "tests/Fictional.Orders.IntegrationTests/OrderRepositoryTests.cs",
          "tests/Fictional.Orders.IntegrationTests/appsettings.json",
        ]);
        expect(report.databases).toEqual(["FictionalOrders"]);
        // 導向只發生在測試容器內：測試後追蹤檔案與基底完全相同，也沒有留下資料庫檔案。
        const collected = await c.phase(id, image!, [
          "sh",
          "-c",
          "node /opt/agentflow/collect.mjs",
        ]);
        expect(collected.exitCode, collected.stderr).toBe(0);
        expect(JSON.parse(collected.stdout).files).toEqual([]);
        const leftovers = await c.phase(id, image!, [
          "sh",
          "-c",
          "ls obj/agentflow-sql obj/agentflow-sqlserver 2>&1 | head -2; grep -r 'MSSQLLocalDB' --include=*.json --include=*.cs -l . | sort",
        ]);
        expect(leftovers.stdout).toContain("No such file");
        expect(leftovers.stdout).toContain("appsettings.json");
        expect(leftovers.stdout).toContain("OrderRepositoryTests.cs");
      } finally {
        await c.dispose(id);
      }
    }, 1800000);

    it("同時執行的兩個工作各自啟動 SQL Server，不搶連接埠與資料檔，也只聽本機", async () => {
      const c = new Containers();
      const ids = [randomUUID(), randomUUID()];
      // 列出容器內監聽 1433（0x0599）的位址；只聽本機時是 0100007F。
      const listening =
        'awk \'NR>1 && $4=="0A" && $2 ~ /:0599$/ {print "LISTEN " $2}\' /proc/net/tcp';
      try {
        await Promise.all(
          ids.map(async (id) => {
            await c.prepare(
              id,
              image!,
              execFileSync("tar", [
                "-cf",
                "-",
                "-C",
                "tests/fixtures",
                "localdb-project",
              ]),
            );
            const restore = await c.phase(
              id,
              image!,
              ["sh", "-c", "dotnet restore Fictional.Orders.sln"],
              "line-agentflow_install",
              undefined,
              600000,
            );
            expect(restore.exitCode, restore.stderr).toBe(0);
          }),
        );
        // 「完全開放」網路模式下測試容器接在共用網路上，最容易互相干擾。
        const results = await Promise.all(
          ids.map((id) =>
            c.phase(
              id,
              image!,
              [
                "sh",
                "-c",
                sqlServerTestCommand(
                  { sqlServer, dataSource: "none" },
                  `dotnet test Fictional.Orders.sln --no-restore && ${listening}`,
                ),
              ],
              "line-agentflow_open",
              undefined,
              900000,
            ),
          ),
        );
        for (const result of results) {
          const output = result.stdout + result.stderr;
          expect(result.exitCode, output.slice(-3000)).toBe(0);
          expect(output).toMatch(/Passed!\s+-\s+Failed:\s+0,\s+Passed:\s+3/);
          expect(result.stdout).toContain("LISTEN 0100007F:0599");
          expect(result.stdout).not.toContain("LISTEN 00000000:0599");
        }
      } finally {
        await Promise.all(ids.map((id) => c.dispose(id)));
      }
    }, 1800000);

    it("SQL Server 沒有就緒時不執行測試，標示為測試環境問題並列出跳過的測試", async () => {
      const c = new Containers(),
        id = randomUUID();
      try {
        await c.prepare(
          id,
          image!,
          execFileSync("tar", [
            "-cf",
            "-",
            "-C",
            "tests/fixtures",
            "localdb-project",
          ]),
        );
        const result = await c.phase(
          id,
          image!,
          [
            "sh",
            "-c",
            "AGENTFLOW_SQLSERVER_TIMEOUT_SECONDS=1 agentflow-sqlserver run -- sh -c 'echo 測試命令不該執行; exit 3'",
          ],
          "none",
          undefined,
          120000,
        );
        expect(result.exitCode).toBe(ENVIRONMENT_EXIT);
        expect(result.stdout).not.toContain("測試命令不該執行");
        const message = environmentFailure(
          { sqlServer, test: "dotnet test Fictional.Orders.sln --no-restore" },
          result,
        );
        expect(message).toContain("測試環境問題（不是程式沒過）");
        expect(message).toContain("SQL Server 沒有啟動成功");
        expect(message).toContain(
          "已跳過的測試：測試命令「dotnet test Fictional.Orders.sln --no-restore」整個沒有執行",
        );
      } finally {
        await c.dispose(id);
      }
    }, 300000);
  },
);
