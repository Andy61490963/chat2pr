import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { Containers } from "../server/containers.js";
import {
  CheckEnvironments,
  viaHostGateway,
} from "../server/check-environments.js";
import type { CheckEnvironmentPolicy } from "../shared/check-environment.js";

/**
 * 以真實 Docker 驗證定期檢查環境（#19）：網路只通到該檢查的目標、機密不落地、重用與清除。
 * 使用非正式的 verify- 實例與獨立位址池，結束時只清掉自己建立的資源。
 * 需要先建好檢查映像：docker build -f infra/check/Dockerfile -t <標籤> .，以 CHECK_TEST_IMAGE 指定。
 */
const image = process.env.CHECK_TEST_IMAGE ?? "line-agentflow-check:local";
const instance = "verify-i19-checks";
const pool = "10.219.0.0/24";
const policy: CheckEnvironmentPolicy = { idleMinutes: 120, max: 20 };
const ids = {
  a: "0b3a2d6e-1f00-4c1a-9a00-00000000000a",
  b: "0b3a2d6e-1f00-4c1a-9a00-00000000000b",
  c: "0b3a2d6e-1f00-4c1a-9a00-00000000000c",
};
const hasImage = (() => {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
if (!hasImage)
  console.warn(`略過定期檢查環境的 Docker 測試：找不到映像 ${image}`);

/** 主機在區域網路上的 IPv4：測試目標以發布到主機的連接埠模擬公司內網的設備。 */
function hostAddress() {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? [])
      if (
        a.family === "IPv4" &&
        !a.internal &&
        /^(10\.|192\.168\.)/.test(a.address)
      )
        return a.address;
  return undefined;
}

describe.skipIf(!hasImage)("定期檢查環境（真實 Docker）", () => {
  const containers = new Containers(instance);
  const envs = new CheckEnvironments(containers, { image, pool });
  const targets: string[] = [];
  let host = "";
  let portA = 0,
    portB = 0;

  /** 在檢查映像裡跑一個小 HTTP 服務，發布到主機的隨機連接埠。 */
  async function target(name: string) {
    const c = await containers.docker.createContainer({
      name: `${instance}-target-${name}`,
      Image: image,
      User: "1000:1000",
      Cmd: [
        "node",
        "-e",
        `require('http').createServer((q,r)=>r.end('target-${name}')).listen(8080)`,
      ],
      ExposedPorts: { "8080/tcp": {} },
      Labels: { "io.agentflow.instance": instance, "io.agentflow.test": "i19" },
      HostConfig: { PortBindings: { "8080/tcp": [{ HostPort: "0" }] } },
    });
    targets.push(c.id);
    await c.start();
    const info = await c.inspect();
    return Number(info.NetworkSettings.Ports["8080/tcp"]![0].HostPort);
  }

  /** 只在測試裡進入檢查容器，確認從容器內看到的網路與檔案。 */
  async function inside(checkId: string, script: string) {
    const probe = containers.docker.getContainer(envs.names(checkId).probe);
    const exec = await probe.exec({
      Cmd: ["node", "-e", script],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({});
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      stream.on("data", (b: Buffer) => chunks.push(b));
      stream.on("end", resolve);
    });
    return Buffer.concat(chunks)
      .toString("utf8")
      .replace(/[\x00-\x08]/g, "");
  }
  const connect = (h: string, p: number) =>
    `const s=require('net').connect(${p},'${h}');s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',()=>{console.log('BLOCKED');process.exit(0)});setTimeout(()=>{console.log('BLOCKED');process.exit(0)},3000)`;

  beforeAll(async () => {
    host = hostAddress() ?? "";
    portA = await target("a");
    portB = await target("b");
  }, 60000);

  afterAll(async () => {
    await envs.cleanupAll();
    for (const id of targets)
      await containers.docker
        .getContainer(id)
        .remove({ force: true })
        .catch(() => {});
    await containers.docker
      .getNetwork(envs.egressName)
      .remove()
      .catch(() => {});
  }, 60000);

  it("HTTP 檢查在專用環境執行，第二次重用同一個環境", async () => {
    expect(host).not.toBe("");
    const spec = {
      checkId: ids.a,
      key: "v1",
      kind: "http" as const,
      target: { host, port: portA },
      init: {},
    };
    const url = `http://${host}:${portA}/health`;
    const first = await envs.run(spec, { url, contains: "target-a" }, policy);
    expect(first.created).toBe(true);
    expect(first.result).toMatchObject({ ok: true, status: 200 });
    const before = await containers.docker
      .getContainer(envs.names(ids.a).probe)
      .inspect();
    const second = await envs.run(spec, { url }, policy);
    expect(second.created).toBe(false);
    const after = await containers.docker
      .getContainer(envs.names(ids.a).probe)
      .inspect();
    expect(after.Id).toBe(before.Id);
    expect(envs.list().map((e) => e.checkId)).toEqual([ids.a]);
  }, 90000);

  it("檢查容器只連得到轉接器：另一個 IP:連接埠、網際網路與主機都不通", async () => {
    expect(await inside(ids.a, connect("target", 7000))).toContain("CONNECTED");
    // 同一台主機的另一個連接埠（另一個設備）。
    expect(await inside(ids.a, connect(host, portB))).toContain("BLOCKED");
    // 自己的目標也不能繞過轉接器直接連。
    expect(await inside(ids.a, connect(host, portA))).toContain("BLOCKED");
    expect(await inside(ids.a, connect("1.1.1.1", 443))).toContain("BLOCKED");
    expect(
      await inside(ids.a, connect("host.docker.internal", portA)),
    ).toContain("BLOCKED");
    // 轉接器只轉到登記的目標：經由它拿到的是 target-a，不會是別的服務。
    const body = await inside(
      ids.a,
      "require('http').get({host:'target',port:7000,path:'/'},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>console.log(b))}).on('error',()=>console.log('ERR'))",
    );
    expect(body).toContain("target-a");
  }, 60000);

  it("檢查容器非 root、唯讀、無 capabilities、無主機掛載與 Docker socket", async () => {
    const info = await containers.docker
      .getContainer(envs.names(ids.a).probe)
      .inspect();
    expect(info.Config.User).toBe("1000:1000");
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
    expect(info.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(info.HostConfig.Binds ?? []).toEqual([]);
    expect(info.Mounts).toEqual([]);
    expect(info.HostConfig.Privileged).toBe(false);
    expect(Object.keys(info.NetworkSettings.Networks)).toEqual([
      envs.names(ids.a).network,
    ]);
    const net = await containers.docker
      .getNetwork(envs.names(ids.a).network)
      .inspect();
    expect(net.Internal).toBe(true);
    expect(
      await inside(
        ids.a,
        "const fs=require('fs');console.log(JSON.stringify({uid:process.getuid(),sock:fs.existsSync('/var/run/docker.sock')}))",
      ),
    ).toContain('{"uid":1000,"sock":false}');
  }, 60000);

  it("SQL 檢查的機密只在自己的檢查容器記憶體裡，不在設定、環境變數或其他檢查容器", async () => {
    const connection = (password: string) => ({
      engine: "sqlserver",
      host,
      // 指向一般 HTTP 服務：不是 SQL Server，連線會失敗，但機密已交給檢查容器。
      port: portB,
      database: "fictional_db",
      username: "fictional_reader",
      password,
      encrypt: false,
      trustServerCertificate: true,
      referenceTables: [],
      ssh: null,
    });
    const passwords = {
      b: "fictional-secret-for-check-b",
      c: "fictional-secret-for-check-c",
    };
    for (const id of ["b", "c"] as const)
      await expect(
        envs.run(
          {
            checkId: ids[id],
            key: "v1.c1.n",
            kind: "sql",
            target: { host, port: portB },
            init: { connection: connection(passwords[id]) },
          },
          { sql: "SELECT 1 AS one" },
          policy,
        ),
      ).rejects.toThrow(/資料庫/);
    // 失敗的查詢不會讓環境消失：連線問題可能只是暫時的。
    expect(
      envs
        .list()
        .map((e) => e.checkId)
        .sort(),
    ).toEqual([ids.a, ids.b, ids.c].sort());
    for (const id of ["b", "c"] as const) {
      const info = JSON.stringify(
        await containers.docker
          .getContainer(envs.names(ids[id]).probe)
          .inspect(),
      );
      expect(info).not.toContain(passwords.b);
      expect(info).not.toContain(passwords.c);
    }
    const seen = await inside(
      ids.b,
      `const fs=require('fs');let all='';for(const f of ['/proc/1/environ','/proc/self/environ'])try{all+=fs.readFileSync(f,'utf8')}catch{};const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=d+'/'+e.name;if(e.isDirectory())walk(p);else try{all+=fs.readFileSync(p,'utf8')}catch{}}};walk('/tmp');walk('/opt/check');console.log(JSON.stringify({b:all.includes('${passwords.b}'),c:all.includes('${passwords.c}')}))`,
    );
    expect(seen).toContain('{"b":false,"c":false}');
  }, 120000);

  it("TCP 檢查：目標連接埠有服務才算成功", async () => {
    const tcp = (port: number, key: string) =>
      envs.run(
        {
          checkId: ids.c,
          key,
          kind: "tcp",
          target: { host, port },
          init: {},
        },
        {},
        policy,
      );
    const open = await tcp(portA, "v2");
    expect(open.created).toBe(true);
    expect(open.result).toMatchObject({ ok: true });
    // 換了環境鍵（檢查修改）就重建，舊的 SQL 環境與機密一起清掉。
    const closed = await tcp(1, "v3");
    expect(closed.created).toBe(true);
    expect(closed.result).toMatchObject({ ok: false });
  }, 90000);

  it("有效清單外、環境鍵不同的環境立即清除，網路一起移除", async () => {
    const removed = await envs.sync(new Map([[ids.a, "v1"]]), policy);
    expect(removed.map((r) => r.checkId).sort()).toEqual([ids.b, ids.c].sort());
    expect(removed.every((r) => r.reason === "stale")).toBe(true);
    for (const id of [ids.b, ids.c]) {
      await expect(
        containers.docker.getContainer(envs.names(id).probe).inspect(),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        containers.docker.getNetwork(envs.names(id).network).inspect(),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(envs.list().map((e) => e.checkId)).toEqual([ids.a]);
    await envs.remove(ids.a);
    expect(envs.list()).toEqual([]);
    const left = await containers.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`io.agentflow.instance=${instance}`] }),
    });
    expect(left.filter((c) => c.Labels["io.agentflow.check"])).toEqual([]);
  }, 90000);
});

/**
 * 真的連上 SQL Server（選用：啟動 SQL Server 約需 30 秒、2 GB 記憶體）。
 * CHECK_TEST_MSSQL_IMAGE=mcr.microsoft.com/mssql/server:2022-latest 時執行。
 * 資料庫只發布在主機的回環介面，連線設定寫 localhost，驗證經主機閘道轉接。
 */
const mssqlImage = process.env.CHECK_TEST_MSSQL_IMAGE;
describe.skipIf(!hasImage || !mssqlImage)(
  "SQL 檢查連上真的 SQL Server（真實 Docker）",
  () => {
    const containers = new Containers(instance);
    const envs = new CheckEnvironments(containers, { image, pool });
    const id = "0b3a2d6e-1f00-4c1a-9a00-00000000000d";
    const password = "Fictional-Check-Passw0rd!";
    let server: string | undefined;
    let port = 0;
    beforeAll(async () => {
      const c = await containers.docker.createContainer({
        name: `${instance}-mssql`,
        Image: mssqlImage,
        Env: [
          "ACCEPT_EULA=Y",
          `MSSQL_SA_PASSWORD=${password}`,
          "MSSQL_MEMORY_LIMIT_MB=2048",
        ],
        ExposedPorts: { "1433/tcp": {} },
        Labels: {
          "io.agentflow.instance": instance,
          "io.agentflow.test": "i19",
        },
        HostConfig: {
          PortBindings: {
            "1433/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }],
          },
        },
      });
      server = c.id;
      await c.start();
      port = Number(
        (await c.inspect()).NetworkSettings.Ports["1433/tcp"]![0].HostPort,
      );
    }, 120000);
    afterAll(async () => {
      await envs.cleanupAll();
      if (server)
        await containers.docker
          .getContainer(server)
          .remove({ force: true })
          .catch(() => {});
      await containers.docker
        .getNetwork(envs.egressName)
        .remove()
        .catch(() => {});
    }, 60000);

    it("唯讀查詢在交易中執行並回傳結果；同一環境重用", async () => {
      const spec = {
        checkId: id,
        key: "v1.c1.n",
        kind: "sql" as const,
        target: { host: viaHostGateway("localhost"), port },
        init: {
          connection: {
            engine: "sqlserver",
            host: "localhost",
            port,
            database: "master",
            username: "sa",
            password,
            encrypt: false,
            trustServerCertificate: true,
            referenceTables: [],
            ssh: null,
          },
        },
      };
      const sql = "SELECT 2 AS n, @@TRANCOUNT AS open_tx";
      let rows: unknown,
        last = "";
      // SQL Server 啟動需要時間：第一次可能因尚未接受連線而失敗，環境本身會保留。
      for (let i = 0; i < 30 && !rows; i++)
        rows = await envs
          .run(spec, { sql }, policy)
          .then((r) => r.result)
          .catch((e: Error) => {
            last = e.message;
            return new Promise((r) => setTimeout(() => r(undefined), 3000));
          });
      expect(rows, last).toEqual({ rows: [{ n: 2, open_tx: 1 }] });
      const again = await envs.run(spec, { sql }, policy);
      expect(again.created).toBe(false);
    }, 150000);
  },
);
