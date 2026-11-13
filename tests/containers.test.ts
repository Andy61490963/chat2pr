import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Containers } from "../server/containers.js";
import { execFileSync } from "node:child_process";
describe("實際工作容器隔離", () => {
  it("超時會停止容器，並清除該階段程序", async () => {
    const c = new Containers(),
      id = randomUUID();
    try {
      await expect(
        c.phase(
          id,
          process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
          ["node", "-e", "setInterval(()=>{},1000)"],
          "none",
          undefined,
          1000,
        ),
      ).rejects.toThrow("時間限制");
      expect(
        await c.docker.listContainers({
          all: true,
          filters: JSON.stringify({ label: [`io.agentflow.run=${id}`] }),
        }),
      ).toHaveLength(0);
    } finally {
      await c.dispose(id);
    }
  }, 10000);
  it("專案副本可寫且能收集差異；安裝階段只可透過白名單代理存取套件", async () => {
    const c = new Containers(),
      id = randomUUID();
    try {
      await c.prepare(
        id,
        process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
        execFileSync("git", [
          "archive",
          "--format=tar",
          "--prefix=fixture/",
          "HEAD",
          "README.md",
        ]),
      );
      const changed = await c.phase(
        id,
        process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
        [
          "sh",
          "-c",
          "set -eu; printf '測試內容' > new-file.txt; printf '\\n既有檔案也可修改\\n' >> README.md; node /opt/agentflow/collect.mjs",
        ],
      );
      expect(changed.exitCode).toBe(0);
      expect(
        JSON.parse(changed.stdout).files.map((f: { path: string }) => f.path),
      ).toEqual(["README.md", "new-file.txt"]);
      const allowed = await c.phase(
        id,
        process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
        ["npm", "view", "zod", "name"],
        "line-agentflow_install",
        undefined,
        30000,
      );
      expect(allowed.exitCode, allowed.stderr).toBe(0);
      expect(allowed.stdout).toContain("zod");
      const blocked = await c.phase(
        id,
        process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
        [
          "node",
          "-e",
          `const net=require('net');const s=net.connect(5439,'host.docker.internal');s.on('connect',()=>{console.log('外洩');process.exit(5)});s.on('error',()=>process.exit(0));setTimeout(()=>{s.destroy();process.exit(0)},2000);`,
        ],
        "line-agentflow_install",
        undefined,
        5000,
      );
      expect(blocked.exitCode).toBe(0);
      const proxy = await c.phase(
        id,
        process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
        [
          "node",
          "-e",
          `const http=require('http');const r=http.request({host:'egress',port:3128,method:'CONNECT',path:'host.docker.internal:443'});r.on('connect',(res,s)=>{console.log(res.statusCode);s.destroy()});r.end()`,
        ],
        "line-agentflow_install",
        undefined,
        5000,
      );
      expect(proxy.stdout.trim()).toBe("403");
    } finally {
      await c.dispose(id);
    }
  }, 60000);
  it("跨工作重用唯讀 NuGet 套件，還原成果保留於各自的工作卷", async () => {
    const c = new Containers(`verify-nuget-${randomUUID().slice(0, 8)}`);
    const feed = `agentflow-${c.instance}-nuget-feed-v1`;
    const image =
      process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local";
    await c.docker.createVolume({
      Name: feed,
      Labels: {
        "io.agentflow.instance": c.instance,
        "io.agentflow.nuget-feed": "v1",
      },
    });
    try {
      execFileSync("docker", [
        "run",
        "--rm",
        "--user",
        "0:0",
        "--network",
        "none",
        "--mount",
        `type=volume,source=${feed},target=/feed`,
        image,
        "sh",
        "-ec",
        [
          "cd /tmp",
          "printf '%s' '<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net8.0</TargetFramework><PackageId>AgentFlow.CacheFixture</PackageId><Version>1.0.0</Version></PropertyGroup></Project>' > seed.csproj",
          "dotnet pack seed.csproj --output /feed",
        ].join("; "),
      ]);
      const archive = execFileSync("git", [
        "archive",
        "--format=tar",
        "--prefix=fixture/",
        "HEAD",
        "README.md",
      ]);
      for (let run = 0; run < 2; run++) {
        const id = randomUUID();
        try {
          await c.prepare(id, image, archive);
          const restored = await c.phase(
            id,
            image,
            [
              "sh",
              "-ec",
              [
                "test ! -e obj/nuget/agentflow.cachefixture",
                "mkdir -p /tmp/empty",
                'printf \'%s\' \'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><RestoreSources>/tmp/empty</RestoreSources></PropertyGroup><ItemGroup><PackageReference Include="AgentFlow.CacheFixture" Version="[1.0.0]" /></ItemGroup></Project>\' > fixture.csproj',
                'test -f "$RestoreAdditionalProjectSources/AgentFlow.CacheFixture.1.0.0.nupkg"',
                'if touch "$RestoreAdditionalProjectSources/不可寫"; then exit 3; fi',
                "dotnet restore fixture.csproj",
              ].join("; "),
            ],
            "none",
            undefined,
            20000,
            false,
            true,
            undefined,
            { nugetFeed: true },
          );
          expect(restored.exitCode, restored.stdout + restored.stderr).toBe(0);
          const built = await c.phase(
            id,
            image,
            [
              "sh",
              "-ec",
              "test ! -e /opt/agentflow/nuget-feed; test -f obj/nuget/agentflow.cachefixture/1.0.0/agentflow.cachefixture.1.0.0.nupkg; dotnet build fixture.csproj --no-restore",
            ],
            "none",
            undefined,
            20000,
          );
          expect(built.exitCode, built.stdout + built.stderr).toBe(0);
        } finally {
          await c.dispose(id);
        }
      }
    } finally {
      await c.docker.getVolume(feed).remove();
    }
  }, 90000);
  it("非 root、沒有主金鑰、沒有 Docker socket，測試階段禁止對外網路", async () => {
    const c = new Containers(),
      id = randomUUID();
    await c.ensureVolume(c.volume(id), id);
    try {
      const result = await c.phase(
        id,
        process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
        [
          "node",
          "-e",
          "const fs=require('fs');console.log(JSON.stringify({uid:process.getuid(),key:!!process.env.OPENAI_API_KEY,socket:fs.existsSync('/var/run/docker.sock')}));try{fs.writeFileSync('/should-not-write','x');process.exitCode=3}catch{}",
        ],
        "none",
        undefined,
        10000,
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        uid: 1000,
        key: false,
        socket: false,
      });
    } finally {
      await c.dispose(id);
    }
  }, 30000);
  it("傳入的工作資料可經 stdin 讀取而非存成檔案", async () => {
    const c = new Containers(),
      id = randomUUID();
    await c.ensureVolume(c.volume(id), id);
    try {
      const message = '繁體中文「驗收」\n含有引號 " 與反斜線 \\ '.repeat(5000);
      // 多次全新連線涵蓋 HTTP 升級競態，並檢查中文分塊完整性。
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await c.phase(
          id,
          process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
          [
            "node",
            "-e",
            "(async()=>{let s='';process.stdin.setEncoding('utf8');for await(const c of process.stdin){s+=c;if(s.includes('\\n'))break;}console.log(JSON.stringify(JSON.parse(s).message))})()",
          ],
          "none",
          JSON.stringify({ message }),
          10000,
        );
        expect(r.exitCode, r.stderr.slice(-400)).toBe(0);
        expect(JSON.parse(r.stdout)).toBe(message);
      }
    } finally {
      await c.dispose(id);
    }
  }, 30000);
  it("審查容器即使直接執行命令也不能改寫專案或可信基底", async () => {
    const c = new Containers(),
      id = randomUUID();
    try {
      await c.prepare(
        id,
        process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
        execFileSync("git", [
          "archive",
          "--format=tar",
          "--prefix=fixture/",
          "HEAD",
          "README.md",
        ]),
      );
      const result = await c.phase(
        id,
        process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
        [
          "node",
          "-e",
          "const fs=require('fs');const read=fs.readFileSync('/workspace/README.md','utf8');let blocked=0;for(const p of ['/workspace/README.md','/baseline/HEAD','/host-secret']){try{fs.writeFileSync(p,'不允許的修改')}catch(e){if(['EROFS','EACCES','EPERM'].includes(e.code))blocked++;else throw e}}console.log(JSON.stringify({blocked,unchanged:read===fs.readFileSync('/workspace/README.md','utf8')}));",
        ],
        "none",
        undefined,
        10000,
        true,
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        blocked: 3,
        unchanged: true,
      });
    } finally {
      await c.dispose(id);
    }
  }, 30000);
});
