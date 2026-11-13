import { afterAll, afterEach, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import {
  collectCandidate,
  prepareReviewEvidence,
} from "../worker/trusted-changes.mjs";
import {
  assertChangeLimits,
  buildOutputHint,
  compileExcludes,
  matchExclude,
} from "../worker/change-policy.mjs";
import {
  DEFAULT_COLLECT_EXCLUDES,
  effectiveCollectExcludes,
  excludedSummary,
  validCollectExclude,
} from "../shared/build-output.js";
import { prReport } from "../server/pr-body.js";
import { buildApp } from "../server/app.js";
import { db, fixture as projectFixture, reset, session } from "./helpers.js";
import type { Project } from "../shared/types.js";

const defaults = effectiveCollectExcludes();
const scratch: string[] = [];
// 只有管理 API 的測試需要資料庫；其他測試不碰共用的測試資料庫。
afterEach(async () => {
  for (const root of scratch.splice(0))
    await rm(root, { recursive: true, force: true });
});
afterAll(() => db.close());

// 虛構的 .NET 與前端混合專案；.gitignore 刻意沒有忽略任何建置輸出。
async function repo() {
  const parent = path.resolve(".local/review-fixtures");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "build-"));
  scratch.push(root);
  const workspace = path.join(root, "workspace"),
    baseline = path.join(root, "baseline");
  const put = async (name: string, content: string | Buffer) => {
    await mkdir(path.dirname(path.join(workspace, name)), { recursive: true });
    await writeFile(path.join(workspace, name), content);
  };
  await put(".gitignore", "*.log\n");
  await put("src/Demo.Api/Program.cs", 'Console.WriteLine("舊");\n');
  await put("web/dist/app.js", "console.log('已提交的建置結果');\n");
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-C", workspace, "-c", "core.autocrlf=false", ...args],
      { encoding: "utf8", windowsHide: true },
    );
  git(["init", "-q"]);
  git(["add", "-A"]);
  git([
    "-c",
    "user.name=驗收",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-qm",
    "虛構專案基底",
  ]);
  await cp(path.join(workspace, ".git"), baseline, { recursive: true });
  return { workspace, baseline, scratchRoot: root, put };
}

it("預設清單涵蓋 .NET、前端與 Python；專案可增減，! 移除預設", () => {
  expect(DEFAULT_COLLECT_EXCLUDES).toEqual(
    expect.arrayContaining([
      "bin/",
      "obj/",
      "TestResults/",
      "node_modules/",
      "dist/",
      "build/",
      ".next/",
      "coverage/",
      "__pycache__/",
      ".pytest_cache/",
      "*.pyc",
    ]),
  );
  const list = effectiveCollectExcludes([
    "out/",
    "!build/",
    "out/",
    "!不存在/",
  ]);
  expect(list).toContain("out/");
  expect(list).not.toContain("build/");
  expect(list.filter((x) => x === "out/")).toHaveLength(1);
  for (const bad of [
    "../x/",
    "/abs/",
    "a\\b",
    "",
    "!",
    "a/[b]",
    ".git/",
    "a//b",
  ])
    expect(validCollectExclude(bad), bad).toBe(false);
  for (const good of ["out/", "!dist/", "src/gen/", "*.dll", "docs/*.pdf"])
    expect(validCollectExclude(good), good).toBe(true);
  expect(() => compileExcludes(["!dist/"])).toThrow("排除清單格式不合法");
});

it("比對規則：目錄任何層、根目錄起的目錄、檔名萬用字元；群組是最外層的符合目錄", () => {
  const rules = compileExcludes([...defaults, "src/gen/", "docs/*.pdf"]);
  expect(matchExclude("src/Demo.Api/bin/Debug/Demo.dll", rules)).toMatchObject({
    rule: "bin/",
    group: "src/Demo.Api/bin/",
  });
  expect(matchExclude("node_modules/a/node_modules/b.js", rules)).toMatchObject(
    { group: "node_modules/" },
  );
  expect(matchExclude("app/__pycache__/m.pyc", rules)?.group).toBe(
    "app/__pycache__/",
  );
  expect(matchExclude("tools/x.pyc", rules)).toMatchObject({
    rule: "*.pyc",
    group: "tools/*.pyc",
  });
  expect(matchExclude("src/gen/a/b.cs", rules)?.group).toBe("src/gen/");
  expect(matchExclude("other/src/gen/b.cs", rules)).toBeNull();
  expect(matchExclude("docs/report.pdf", rules)?.group).toBe("docs/report.pdf");
  // 名稱只是剛好叫 bin 的檔案不算目錄。
  expect(matchExclude("scripts/bin", rules)).toBeNull();
  expect(matchExclude("src/binary/x.cs", rules)).toBeNull();
});

it("驗收：測試後產生 bin/、obj/ 且 .gitignore 沒忽略時，收集到的變更只有原始碼", async () => {
  const f = await repo();
  await f.put("src/Demo.Api/Program.cs", 'Console.WriteLine("新");\n');
  await f.put("src/Demo.Api/Feature.cs", "class Feature {}\n");
  await f.put(
    "src/Demo.Api/bin/Debug/net8.0/Demo.Api.dll",
    Buffer.alloc(6e6, 1),
  );
  await f.put("src/Demo.Api/obj/project.assets.json", "{}".repeat(3e6));
  await f.put("tests/Demo.Tests/TestResults/run.trx", "<TestRun/>");
  await f.put("tools/__pycache__/helper.cpython-312.pyc", Buffer.alloc(10, 2));
  const collected = await collectCandidate({
    ...f,
    exclude: defaults,
  });
  expect(collected.files.map((x) => x.path).sort()).toEqual([
    "src/Demo.Api/Feature.cs",
    "src/Demo.Api/Program.cs",
  ]);
  expect(collected.diff).not.toContain("Demo.Api.dll");
  expect(collected.stat).not.toContain("obj/");
  expect(collected.excluded).toMatchObject({ files: 4, totalGroups: 4 });
  expect(collected.excluded.groups.map((g) => g.path).sort()).toEqual([
    "src/Demo.Api/bin/",
    "src/Demo.Api/obj/",
    "tests/Demo.Tests/TestResults/",
    "tools/__pycache__/",
  ]);
  expect(collected.excluded.bytes).toBeGreaterThan(12e6);
  // 審查重算時使用同一份清單才一致；漏傳清單會被當成候選內容改變。
  await expect(
    prepareReviewEvidence(collected.manifest, { ...f, exclude: defaults }),
  ).resolves.toMatchObject({ complete: true });
  await expect(prepareReviewEvidence(collected.manifest, f)).rejects.toThrow();
  expect(excludedSummary(collected.excluded)).toContain(
    "src/Demo.Api/bin/（1 個檔案）",
  );
});

it("驗收：原本就被追蹤的 dist/ 修改與其中的新檔案照常收集", async () => {
  const f = await repo();
  await f.put("web/dist/app.js", "console.log('重新建置');\n");
  await f.put("web/dist/chunk-1.js", "console.log('新產生的區塊');\n");
  await f.put("web/src/dist/notes.md", "未追蹤目錄裡的新檔案仍排除\n");
  const collected = await collectCandidate({ ...f, exclude: defaults });
  expect(collected.files.map((x) => x.path).sort()).toEqual([
    "web/dist/app.js",
    "web/dist/chunk-1.js",
  ]);
  expect(collected.excluded.groups.map((g) => g.path)).toEqual([
    "web/src/dist/",
  ]);
});

it("未提供排除清單時行為與原本相同；專案移除預設後照常收集", async () => {
  const f = await repo();
  await f.put("build/deploy.sh", "echo 部署\n");
  const plain = await collectCandidate(f);
  expect(plain.files.map((x) => x.path)).toEqual(["build/deploy.sh"]);
  expect(plain.excluded).toMatchObject({ files: 0, groups: [] });
  const kept = await collectCandidate({
    ...f,
    exclude: effectiveCollectExcludes(["!build/"]),
  });
  expect(kept.files.map((x) => x.path)).toEqual(["build/deploy.sh"]);
});

it("驗收：超過上限時列出最大的 10 個檔案與大小，判斷像建置產物並建議加入排除清單", async () => {
  const f = await repo();
  await f.put("src/Demo.Api/Program.cs", 'Console.WriteLine("新");\n');
  // 被預設排除的大檔不計入上限。
  await f.put("src/Demo.Api/bin/Demo.Api.dll", Buffer.alloc(8e6, 1));
  for (let i = 0; i < 12; i++)
    await f.put(
      `out/publish/part-${String(i).padStart(2, "0")}.dll`,
      Buffer.alloc(1e6 + i, 3),
    );
  const failure = await collectCandidate({ ...f, exclude: defaults }).then(
    () => null,
    (e: Error) => e.message,
  );
  expect(failure).toContain("超過 10 MiB");
  expect(failure).toContain("已自動排除 1 個建置產物檔案");
  expect(failure).toContain("最大 10 個檔案");
  expect(failure).toContain(
    '"out/publish/part-11.dll"：1000011 bytes（1.0 MB，像建置產物）',
  );
  expect(failure).not.toContain("part-01.dll");
  expect(failure).toContain("「收集時排除」加入 `out/`");
  expect(failure).toContain("未刪除任何檔案、未發布");
});

it("超過上限但不像建置產物時，建議移出中介產物，不建議排除", () => {
  const files = Array.from({ length: 12 }, (_, i) => ({
    path: `docs/screens/shot-${i}.png`,
    bytes: 1e6,
    added: true,
  }));
  expect(() => assertChangeLimits(files)).toThrow(/這些檔案不像建置產物/);
  // 原本就追蹤的檔案不能靠排除清單處理，所以不標示。
  expect(() =>
    assertChangeLimits([
      { path: "lib/bin/tool.dll", bytes: 11e6, added: false },
    ]),
  ).toThrow(/這些檔案不像建置產物/);
  expect(buildOutputHint("a/obj/x.json")).toBe("obj/");
  expect(buildOutputHint("pkg/lib.so")).toBe("*.so");
  expect(buildOutputHint("src/view.ts")).toBeNull();
});

it("PR 說明列出被排除的目錄、檔案數與規則；沒有排除時不出現段落", () => {
  const excluded = {
    files: 41,
    bytes: 12 * 1024 * 1024,
    totalGroups: 31,
    groups: [
      { path: "src/Demo.Api/bin/", rule: "bin/", files: 40, bytes: 12e6 },
      { path: "a|b`/obj/", rule: "obj/", files: 1, bytes: 10 },
    ],
  };
  const body = prReport({
    codexSummary: "新增功能",
    testCommand: "dotnet test",
    testOutput: "Passed!",
    excluded,
  });
  expect(body).toContain("## 收集時排除的建置產物");
  expect(body).toContain("| `src/Demo.Api/bin/` | 40 | 11.4 MB | `bin/` |");
  expect(body).toContain("| `a_b_/obj/` | 1 | 10 B | `obj/` |");
  expect(body).toContain("另有 29 組未列出");
  expect(
    prReport({ codexSummary: "x", testCommand: "", testOutput: "" }),
  ).not.toContain("收集時排除");
});

it("進階設定可儲存排除清單的增減；省略時保留，不合法的規則被拒絕", async () => {
  await reset();
  const id = await projectFixture(),
    app = await buildApp(db),
    headers = await session();
  const load = () =>
    db.one<Project>("SELECT * FROM projects WHERE id=$1", [id]);
  const put = async (patch: Record<string, unknown>) => {
    const p = await load();
    const { collect_excludes: _omit, ...rest } = p!;
    return app.inject({
      method: "PUT",
      url: `/api/projects/${id}`,
      headers,
      payload: { ...rest, enabled: false, ...patch },
    });
  };
  try {
    expect((await load())!.collect_excludes).toEqual([]);
    const saved = await put({ collect_excludes: [" out/", "!dist/", "out/"] });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await load())!.collect_excludes).toEqual(["out/", "!dist/"]);
    // 調整排除清單不影響環境，不需要重新驗證。
    expect(saved.json().config_version).toBe((await load())!.config_version);
    expect((await put({})).statusCode).toBe(200);
    expect((await load())!.collect_excludes).toEqual(["out/", "!dist/"]);
    const bad = await put({ collect_excludes: ["../secret/"] });
    expect(bad.statusCode).toBe(400);
    expect((await load())!.collect_excludes).toEqual(["out/", "!dist/"]);
  } finally {
    await app.close();
  }
});

it("Linux 真容器：collect.mjs 依環境變數的清單排除新產生的建置輸出", () => {
  const script = `
import fs from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
const git=(args)=>execFileSync('git',['-C','/workspace','-c','core.hooksPath=/dev/null',...args],{encoding:'utf8'});
await fs.writeFile('/workspace/app.cs','舊');
git(['init','-q']);git(['add','-A']);git(['-c','user.name=驗收','-c','user.email=test@localhost','commit','-qm','基底']);
await fs.cp('/workspace/.git','/baseline',{recursive:true});
await fs.writeFile('/workspace/app.cs','新');
await fs.mkdir('/workspace/bin/Release',{recursive:true});
await fs.writeFile('/workspace/bin/Release/app.dll',Buffer.alloc(11*1024*1024,1));
await fs.mkdir('/workspace/node_modules/.bin',{recursive:true});
await fs.symlink('../x/cli.js','/workspace/node_modules/.bin/cli');
const run=(env)=>spawnSync('node',['/opt/agentflow/collect.mjs'],{encoding:'utf8',maxBuffer:32*1024*1024,env:{...process.env,...env}});
const excluded=run({AGENTFLOW_COLLECT_EXCLUDE:JSON.stringify(${JSON.stringify(defaults)})});
const plain=run({});
const body=excluded.status===0?JSON.parse(excluded.stdout):null;
process.stdout.write(JSON.stringify({status:excluded.status,stderr:excluded.stderr,files:body?.files.map(f=>f.path),groups:body?.excluded.groups.map(g=>g.path),plainStatus:plain.status,plainStderr:plain.stderr}));
`;
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/workspace:rw,size=40m,uid=1000,gid=1000,mode=0700",
      "--tmpfs",
      "/baseline:rw,size=8m,uid=1000,gid=1000,mode=0700",
      "--tmpfs",
      "/tmp:rw,size=80m,mode=1777",
      "-v",
      `${path.resolve("worker")}:/opt/agentflow:ro`,
      "--entrypoint",
      "node",
      process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
      "--input-type=module",
      "-",
    ],
    {
      input: script,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const out = JSON.parse(result.stdout);
  expect(out.status, out.stderr).toBe(0);
  expect(out.files).toEqual(["app.cs"]);
  expect(out.groups.sort()).toEqual(["bin/", "node_modules/"]);
  // 沒有清單時維持原本的行為：符號連結與超限都會擋下。
  expect(out.plainStatus).not.toBe(0);
}, 30000);
