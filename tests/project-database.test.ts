import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createServer, connect, type AddressInfo, type Server } from "node:net";
import ssh2 from "ssh2";
import { db, fixture, reset, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import type { Project } from "../shared/types.js";
import { openTunnel } from "../server/database-capture.js";
import {
  captureSqlServer,
  columnType,
  resolveReferenceTables,
  type Row,
} from "../server/sqlserver-schema.js";

vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({ sessionSecret: "fictional-session-secret-for-tests" }),
}));

// 全部是虛構憑證；用來確認它們不會出現在任何輸出。
const password = "Fictional-Db-Pass-123";
const privateKey =
  "-----BEGIN FICTIONAL KEY-----fictional-key-body-----END-----";
const connectionBody = {
  engine: "sqlserver",
  host: "db.example.test",
  port: 1433,
  database: "mes",
  username: "schema_reader",
  password,
  encrypt: true,
  trustServerCertificate: true,
  referenceTables: ["StatusCode"],
  ssh: {
    host: "jump.example.test",
    port: 22,
    username: "deploy",
    privateKey,
    passphrase: "fictional-passphrase",
  },
};
const capture = (hash = "fictional-hash-1") => ({
  files: {
    "schema.sql": "CREATE TABLE [dbo].[Orders] ([Id] int NOT NULL);\nGO\n",
    "foreign-keys.sql": "",
    "README.md": "說明",
  },
  objects: { tables: 1, views: 0 },
  tables: ["dbo.Orders"],
  referenceRows: 0,
  warnings: [],
  hash,
  hostKey: "SHA256:fictional-host-key",
});

let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(reset);
afterEach(async () => {
  await app?.close();
});
afterAll(() => db.close());

async function scenario(mode: "auto" | "manual" = "auto") {
  const id = await fixture();
  await db.query("UPDATE projects SET setup_mode=$2 WHERE id=$1", [id, mode]);
  const calls: { path: string; body: Record<string, any> }[] = [];
  const enqueued: string[] = [];
  let snapshot = capture();
  let failure: Error | undefined;
  app = await buildApp(
    db,
    async (projectId) => {
      enqueued.push(projectId);
    },
    undefined,
    undefined,
    {
      call: async <T>(path: string, body: unknown): Promise<T> => {
        calls.push({ path, body: body as Record<string, any> });
        if (failure) throw failure;
        return (
          path === "database/test"
            ? {
                ok: true,
                server: "SQL Server 16.0",
                tables: 12,
                canViewDefinition: true,
                canWrite: false,
                hostKey: "SHA256:fictional-host-key",
              }
            : snapshot
        ) as T;
      },
    },
  );
  const headers = await session();
  const request = (method: string, path = "", payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url: `/api/projects/${id}/database${path}`,
      headers,
      ...(payload ? { payload } : {}),
    });
  return {
    id,
    calls,
    enqueued,
    headers,
    request,
    project: () => db.one<Project>("SELECT * FROM projects WHERE id=$1", [id]),
    next: (value: ReturnType<typeof capture>) => {
      snapshot = value;
    },
    fail: (error: Error) => {
      failure = error;
    },
  };
}

describe("專案資料庫連線", () => {
  it("沒有登入或不是管理者時不能讀寫連線", async () => {
    const s = await scenario();
    for (const [method, path] of [
      ["GET", ""],
      ["PUT", ""],
      ["DELETE", ""],
      ["POST", "/test"],
      ["POST", "/snapshot"],
      ["DELETE", "/snapshot"],
    ])
      expect(
        (
          await app.inject({
            method: method as "GET",
            url: `/api/projects/${s.id}/database${path}`,
            payload: connectionBody,
          })
        ).statusCode,
      ).toBe(401);
    expect(s.calls).toHaveLength(0);
  });

  it("密碼與私鑰只寫入：回應、資料庫明文欄位與稽核紀錄都找不到", async () => {
    const s = await scenario();
    const saved = await s.request("PUT", "", connectionBody);
    expect(saved.statusCode).toBe(200);
    const read = await s.request("GET");
    for (const text of [saved.body, read.body]) {
      expect(text).not.toContain(password);
      expect(text).not.toContain("fictional-key-body");
      expect(text).not.toContain("fictional-passphrase");
    }
    expect(read.json().connection).toMatchObject({
      host: "db.example.test",
      database: "mes",
      username: "schema_reader",
      referenceTables: ["StatusCode"],
      ssh: { host: "jump.example.test", auth: "key", hostKey: null },
    });
    const stored = await db.one<{ dump: string }>(
      "SELECT row_to_json(c)::text || encode(c.secret,'escape') AS dump FROM project_connections c WHERE project_id=$1",
      [s.id],
    );
    expect(stored!.dump).not.toContain(password);
    expect(stored!.dump).not.toContain("fictional-key-body");
    const trail = await db.query<{ detail: string }>(
      "SELECT detail FROM audit WHERE kind='project_database'",
    );
    expect(trail).toHaveLength(1);
    // 活動紀錄所有成員都看得到：只寫發生了什麼，不寫主機與資料庫名稱。
    expect(trail[0].detail).toContain("資料庫連線");
    expect(trail[0].detail).not.toContain("db.example.test");
    expect(trail[0].detail).not.toContain(password);
    // /api/state 的專案資料不帶連線資訊。
    const state = await app.inject({ url: "/api/state", headers: s.headers });
    expect(state.body).not.toContain("db.example.test");
    expect(state.body).not.toContain(password);
  });

  it("第一次儲存必須有密碼；之後留空代表沿用，主機格式不對會被拒絕", async () => {
    const s = await scenario();
    const { password: _omitted, ...withoutPassword } = connectionBody;
    expect((await s.request("PUT", "", withoutPassword)).statusCode).toBe(422);
    expect(
      (await s.request("PUT", "", { ...connectionBody, host: "http://db/x" }))
        .statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect((await s.request("PUT", "", connectionBody)).statusCode).toBe(200);
    // 只改資料庫名稱，密碼與 SSH 憑證留空。
    const changed = await s.request("PUT", "", {
      ...withoutPassword,
      database: "mes_test",
      ssh: { host: "jump.example.test", port: 22, username: "deploy" },
    });
    expect(changed.statusCode).toBe(200);
    await s.request("POST", "/test");
    expect(s.calls[0]).toMatchObject({
      path: "database/test",
      body: {
        database: "mes_test",
        password,
        ssh: { privateKey, passphrase: "fictional-passphrase" },
      },
    });
    // 換了跳板主機就不能沿用舊憑證。
    expect(
      (
        await s.request("PUT", "", {
          ...withoutPassword,
          ssh: { host: "other.example.test", port: 22, username: "deploy" },
        })
      ).statusCode,
    ).toBe(422);
  });

  it("測試連線由執行器進行，記下第一次看到的 SSH 主機金鑰，回應不含機密", async () => {
    const s = await scenario();
    expect((await s.request("POST", "/test")).statusCode).toBe(404);
    await s.request("PUT", "", connectionBody);
    const tested = await s.request("POST", "/test");
    expect(tested.json()).toEqual({
      ok: true,
      server: "SQL Server 16.0",
      tables: 12,
      canViewDefinition: true,
      canWrite: false,
    });
    expect((await s.request("GET")).json().connection.ssh.hostKey).toBe(
      "SHA256:fictional-host-key",
    );
    await s.request("POST", "/test");
    expect(s.calls[1].body.ssh.hostKey).toBe("SHA256:fictional-host-key");
  });

  it("執行器回報的白話失敗原因原樣交給擁有者", async () => {
    const s = await scenario();
    await s.request("PUT", "", connectionBody);
    const { AppError } = await import("../server/policy.js");
    s.fail(new AppError(422, "資料庫拒絕登入，請檢查帳號、密碼與資料庫名稱。"));
    const tested = await s.request("POST", "/test");
    expect(tested.statusCode).toBe(422);
    expect(tested.body).toContain("資料庫拒絕登入");
    expect(tested.body).not.toContain(password);
  });

  it("擷取快照後顯示版本與物件數量；自動模式的專案作廢舊驗證並重新排程", async () => {
    const s = await scenario("auto");
    await s.request("PUT", "", connectionBody);
    const before = await s.project();
    const first = await s.request("POST", "/snapshot");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      changed: true,
      queued: true,
      snapshot: { version: 1, objects: { tables: 1 } },
    });
    expect(first.body).not.toContain("CREATE TABLE");
    expect(first.body).not.toContain(password);
    expect(s.calls[0].body.referenceTables).toEqual(["StatusCode"]);
    const after = await s.project();
    expect(after).toMatchObject({
      enabled: false,
      validated_at: null,
      config_version: before!.config_version + 1,
      setup_status: "資料庫結構已更新，等待重新驗證",
    });
    expect(s.enqueued).toEqual([s.id]);

    // 內容沒有變：不升版、不作廢驗證。
    await db.query(
      "UPDATE projects SET enabled=true,validated_at=now() WHERE id=$1",
      [s.id],
    );
    const again = await s.request("POST", "/snapshot");
    expect(again.json()).toMatchObject({
      changed: false,
      queued: false,
      snapshot: { version: 1 },
    });
    expect((await s.project())!.enabled).toBe(true);

    // 結構改變：升版並再次作廢。
    s.next(capture("fictional-hash-2"));
    expect((await s.request("POST", "/snapshot")).json()).toMatchObject({
      changed: true,
      snapshot: { version: 2 },
    });
    expect((await s.project())!.enabled).toBe(false);
  });

  it("手動指令的專案只保存快照，不動既有驗證", async () => {
    const s = await scenario("manual");
    await s.request("PUT", "", connectionBody);
    const result = await s.request("POST", "/snapshot");
    expect(result.json()).toMatchObject({ changed: true, queued: false });
    expect((await s.project())!.enabled).toBe(true);
    expect(s.enqueued).toHaveLength(0);
  });

  it("刪除連線保留快照；刪除快照會讓自動模式的專案重新驗證", async () => {
    const s = await scenario("auto");
    await s.request("PUT", "", connectionBody);
    await s.request("POST", "/snapshot");
    const removed = await s.request("DELETE");
    expect(removed.json()).toMatchObject({
      connection: null,
      snapshot: { version: 1 },
    });
    expect((await s.request("POST", "/snapshot")).statusCode).toBe(404);
    await db.query(
      "UPDATE projects SET enabled=true,validated_at=now() WHERE id=$1",
      [s.id],
    );
    const cleared = await s.request("DELETE", "/snapshot");
    expect(cleared.json()).toMatchObject({ snapshot: null, queued: true });
    expect((await s.project())!.setup_status).toBe(
      "資料庫結構快照已刪除，等待重新驗證",
    );
  });
});

describe("SQL Server 結構指令檔", () => {
  const column = (overrides: Row): Row => ({
    kind: "table",
    sch: "dbo",
    tbl: "Orders",
    type_schema: "sys",
    is_user_defined: false,
    max_length: 4,
    precision: 10,
    scale: 0,
    is_nullable: false,
    is_identity: false,
    is_computed: false,
    ...overrides,
  });
  const catalog: Record<string, Row[]> = {
    "FROM sys.schemas": [{ name: "mes" }],
    "FROM sys.sequences": [],
    "FROM sys.synonyms": [],
    "sys.table_types": [],
    "FROM sys.types t JOIN": [],
    "FROM sys.check_constraints": [
      { sch: "dbo", tbl: "Orders", name: "CK_Qty", definition: "([Qty]>=(0))" },
    ],
    "FROM sys.foreign_keys": [
      {
        name: "FK_Orders_Status",
        sch: "dbo",
        tbl: "Orders",
        ref_sch: "dbo",
        ref_tbl: "Status",
        col: "StatusCode",
        ref_col: "Code",
        on_delete: "NO_ACTION",
        on_update: "CASCADE",
      },
    ],
    "FROM sys.indexes": [
      {
        sch: "dbo",
        tbl: "Orders",
        idx: "PK_Orders",
        index_id: 1,
        index_type: 1,
        is_unique: true,
        is_primary_key: true,
        is_unique_constraint: false,
        filter_definition: null,
        key_ordinal: 1,
        is_included_column: false,
        is_descending_key: false,
        col: "Id",
      },
      {
        sch: "dbo",
        tbl: "Orders",
        idx: "IX_Status",
        index_id: 2,
        index_type: 2,
        is_unique: false,
        is_primary_key: false,
        is_unique_constraint: false,
        filter_definition: "([StatusCode]<>'X')",
        key_ordinal: 1,
        is_included_column: false,
        is_descending_key: true,
        col: "StatusCode",
      },
      {
        sch: "dbo",
        tbl: "Orders",
        idx: "IX_Status",
        index_id: 2,
        index_type: 2,
        is_unique: false,
        is_primary_key: false,
        is_unique_constraint: false,
        filter_definition: "([StatusCode]<>'X')",
        key_ordinal: 0,
        is_included_column: true,
        is_descending_key: false,
        col: "Qty",
      },
    ],
    "FROM sys.objects o LEFT JOIN sys.sql_modules": [
      {
        object_id: 10,
        sch: "dbo",
        name: "vw_Open",
        type: "V",
        definition:
          "CREATE VIEW dbo.vw_Open AS SELECT dbo.fn_Double(Qty) AS Q FROM dbo.Orders",
        uses_ansi_nulls: true,
        uses_quoted_identifier: true,
      },
      {
        object_id: 11,
        sch: "dbo",
        name: "a_First",
        type: "V",
        definition: "CREATE VIEW dbo.a_First AS SELECT Q FROM dbo.vw_Open",
        uses_ansi_nulls: true,
        uses_quoted_identifier: true,
      },
      {
        object_id: 12,
        sch: "dbo",
        name: "fn_Double",
        type: "FN",
        definition:
          "CREATE FUNCTION dbo.fn_Double(@v int) RETURNS int AS BEGIN RETURN @v*2 END",
        uses_ansi_nulls: true,
        uses_quoted_identifier: false,
      },
      {
        object_id: 13,
        sch: "dbo",
        name: "usp_Hidden",
        type: "P",
        definition: null,
      },
    ],
    "FROM sys.tables WHERE is_ms_shipped=0) o": [
      column({
        col: "Id",
        column_id: 1,
        type_name: "int",
        is_identity: true,
        seed: "1",
        incr: "1",
      }),
      column({
        col: "StatusCode",
        column_id: 2,
        type_name: "varchar",
        max_length: 10,
      }),
      column({
        col: "Qty",
        column_id: 3,
        type_name: "decimal",
        precision: 18,
        scale: 4,
        default_def: "((0))",
        default_name: "DF_Qty",
      }),
      column({
        col: "Note",
        column_id: 4,
        type_name: "nvarchar",
        max_length: -1,
        is_nullable: true,
      }),
      column({
        col: "Total",
        column_id: 5,
        type_name: "decimal",
        is_computed: true,
        computed: "([Qty]*(2))",
        is_persisted: true,
      }),
      column({ col: "RowVer", column_id: 6, type_name: "timestamp" }),
      column({
        tbl: "Status",
        col: "Code",
        column_id: 1,
        type_name: "varchar",
        max_length: 10,
      }),
      column({
        tbl: "Status",
        col: "Name",
        column_id: 2,
        type_name: "nvarchar",
        max_length: 100,
      }),
    ],
  };
  const asked: string[] = [];
  const query = async (sql: string) => {
    asked.push(sql);
    if (sql.startsWith("SELECT TOP"))
      return sql.includes("[Status]")
        ? [
            { Code: "NEW", Name: "新建 O'Brien" },
            { Code: "X", Name: null },
          ]
        : [];
    const key = Object.keys(catalog).find((k) => sql.includes(k));
    if (!key) throw new Error(`測試沒有準備這個查詢：${sql.slice(0, 60)}`);
    return catalog[key];
  };

  it("型別長度、精確度與自訂型別的寫法", () => {
    const type = (o: Row) => columnType({ is_user_defined: false, ...o });
    expect(type({ type_name: "nvarchar", max_length: 100 })).toBe(
      "nvarchar(50)",
    );
    expect(type({ type_name: "nvarchar", max_length: -1 })).toBe(
      "nvarchar(max)",
    );
    expect(type({ type_name: "varbinary", max_length: -1 })).toBe(
      "varbinary(max)",
    );
    expect(type({ type_name: "decimal", precision: 18, scale: 4 })).toBe(
      "decimal(18,4)",
    );
    expect(type({ type_name: "datetime2", scale: 3 })).toBe("datetime2(3)");
    expect(type({ type_name: "float", precision: 53 })).toBe("float");
    expect(type({ type_name: "int" })).toBe("int");
    expect(
      columnType({
        type_name: "LotNo",
        type_schema: "mes",
        is_user_defined: true,
      }),
    ).toBe("[mes].[LotNo]");
  });

  it("產生可重建的結構：資料表、索引、條件、依相依順序排列的模組", async () => {
    const result = await captureSqlServer(query, {
      referenceTables: ["Status", "dbo.Orders", "NoSuchTable; DROP TABLE x"],
    });
    const schema = result.files["schema.sql"];
    expect(schema.startsWith("SET ANSI_NULLS ON;")).toBe(true);
    expect(schema).toContain("SET QUOTED_IDENTIFIER ON;");
    expect(schema).toContain("CREATE SCHEMA [mes]");
    expect(schema).toContain(
      "CREATE TABLE [dbo].[Orders] (\n  [Id] int IDENTITY(1,1) NOT NULL,\n  [StatusCode] varchar(10) NOT NULL,\n  [Qty] decimal(18,4) NOT NULL CONSTRAINT [DF_Qty] DEFAULT ((0)),\n  [Note] nvarchar(max) NULL,\n  [Total] AS ([Qty]*(2)) PERSISTED,\n  [RowVer] timestamp NOT NULL\n);",
    );
    expect(schema).toContain(
      "ALTER TABLE [dbo].[Orders] ADD CONSTRAINT [PK_Orders] PRIMARY KEY CLUSTERED ([Id]);",
    );
    expect(schema).toContain(
      "CREATE NONCLUSTERED INDEX [IX_Status] ON [dbo].[Orders] ([StatusCode] DESC) INCLUDE ([Qty]) WHERE ([StatusCode]<>'X');",
    );
    expect(schema).toContain("ADD CONSTRAINT [CK_Qty] CHECK ([Qty]>=(0));");
    // 函式先於用到它的檢視；檢視之間依參考關係而不是名稱排序。
    const order = ["fn_Double(@v", "VIEW dbo.vw_Open", "VIEW dbo.a_First"].map(
      (text) => schema.indexOf(text),
    );
    expect(order.every((position) => position > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(schema).toContain("SET QUOTED_IDENTIFIER OFF;\nGO\nCREATE FUNCTION");
    expect(schema).not.toContain("usp_Hidden");
    expect(result.files["foreign-keys.sql"]).toContain(
      "ALTER TABLE [dbo].[Orders] WITH NOCHECK ADD CONSTRAINT [FK_Orders_Status] FOREIGN KEY ([StatusCode]) REFERENCES [dbo].[Status] ([Code]) ON UPDATE CASCADE;",
    );
    expect(result.objects).toMatchObject({
      tables: 2,
      indexes: 2,
      foreignKeys: 1,
      views: 2,
      functions: 1,
      procedures: 0,
    });
    expect(result.tables).toEqual(["dbo.Orders", "dbo.Status"]);
    expect(result.warnings.join("\n")).toContain("有 1 個");
    expect(result.warnings.join("\n")).toContain("NoSuchTable");
  });

  it("只讀取擁有者列出且確實存在的參考資料表，每表有上限，計算欄位與 rowversion 不匯出", async () => {
    asked.length = 0;
    const result = await captureSqlServer(query, {
      referenceTables: ["Status", "dbo.Orders", "NoSuchTable; DROP TABLE x"],
    });
    const reads = asked.filter((sql) => sql.startsWith("SELECT TOP"));
    expect(reads).toEqual([
      "SELECT TOP (500) [Code], [Name] FROM [dbo].[Status]",
      "SELECT TOP (500) [Id], [StatusCode], [Qty], [Note] FROM [dbo].[Orders]",
    ]);
    expect(asked.join("\n")).not.toContain("DROP TABLE");
    expect(result.referenceRows).toBe(2);
    expect(result.files["reference-data.sql"]).toContain(
      "INSERT INTO [dbo].[Status] ([Code], [Name]) VALUES (N'NEW', N'新建 O''Brien');",
    );
    expect(result.files["reference-data.sql"]).toContain(
      "VALUES (N'X', NULL);",
    );

    // 沒有列出任何資料表時，完全不讀資料列；內容相同時雜湊相同。
    asked.length = 0;
    const plain = await captureSqlServer(query);
    expect(asked.some((sql) => sql.startsWith("SELECT TOP"))).toBe(false);
    expect(plain.files["reference-data.sql"]).toBeUndefined();
    expect((await captureSqlServer(query)).hash).toBe(plain.hash);
    expect(plain.hash).not.toBe(result.hash);
  });

  it("參考資料表名稱比對不分大小寫，預設結構描述是 dbo", () => {
    expect(
      resolveReferenceTables(
        ["status", "[mes].[Lot]", "nope"],
        ["dbo.Status", "mes.Lot"],
      ),
    ).toEqual({ found: ["dbo.Status", "mes.Lot"], missing: ["nope"] });
  });
});

describe("SSH 跳板通道", () => {
  let target: Server, jump: ssh2.Server;
  const listen = (server: { listen: Function; address: Function }) =>
    new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () =>
        resolve((server.address() as AddressInfo).port),
      ),
    );
  const start = async () => {
    target = createServer((socket) =>
      socket.on("data", (d) => socket.write(d)),
    );
    const targetPort = await listen(target);
    const hostKey = ssh2.utils.generateKeyPairSync("ed25519");
    jump = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
      client.on("authentication", (ctx) =>
        ctx.method === "password" && ctx.password === "fictional-jump-pass"
          ? ctx.accept()
          : ctx.reject(["password"]),
      );
      client.on("ready", () =>
        client.on("tcpip", (accept, _reject, info) => {
          const stream = accept();
          const socket = connect(info.destPort, info.destIP);
          stream.pipe(socket).pipe(stream);
          socket.on("error", () => stream.end());
        }),
      );
      client.on("error", () => {});
    });
    return { targetPort, jumpPort: await listen(jump) };
  };
  afterEach(() => {
    target?.close();
    jump?.close();
  });

  it("只在回環介面開轉送，資料經跳板送到目的地；回報主機金鑰指紋", async () => {
    const { targetPort, jumpPort } = await start();
    const tunnel = await openTunnel(
      {
        host: "127.0.0.1",
        port: jumpPort,
        username: "deploy",
        password: "fictional-jump-pass",
      },
      { host: "127.0.0.1", port: targetPort },
    );
    try {
      expect(tunnel.hostKey).toMatch(/^SHA256:/);
      const echoed = await new Promise<string>((resolve, reject) => {
        const socket = connect(tunnel.port, "127.0.0.1", () =>
          socket.write("ping"),
        );
        socket.on("data", (d) => {
          resolve(d.toString());
          socket.destroy();
        });
        socket.on("error", reject);
      });
      expect(echoed).toBe("ping");
    } finally {
      tunnel.close();
    }
  });

  it("登入被拒絕或主機金鑰改變時回報固定的白話原因，不回顯憑證", async () => {
    const { targetPort, jumpPort } = await start();
    const ssh = { host: "127.0.0.1", port: jumpPort, username: "deploy" };
    const targetAddress = { host: "127.0.0.1", port: targetPort };
    await expect(
      openTunnel({ ...ssh, password: "fictional-wrong-pass" }, targetAddress),
    ).rejects.toThrow("SSH 跳板拒絕登入，請檢查帳號、私鑰或密碼。");
    await expect(
      openTunnel(
        {
          ...ssh,
          password: "fictional-jump-pass",
          hostKey: "SHA256:fictional-old-key",
        },
        targetAddress,
      ),
    ).rejects.toThrow("主機金鑰和上次不同");
    await expect(
      openTunnel(
        { ...ssh, privateKey: "not-a-key", passphrase: "x" },
        targetAddress,
      ),
    ).rejects.toThrow("SSH 私鑰格式無法讀取");
  });
});
