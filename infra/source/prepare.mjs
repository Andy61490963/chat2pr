import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { createInterface } from "node:readline";

// 只有可信下載工具可讀取快取與短效唯讀憑證；不執行任何專案程式。
const line = await new Promise((resolve, reject) => {
  const lines = createInterface({ input: process.stdin });
  lines.once("line", (value) => {
    resolve(value);
    lines.close();
    process.stdin.destroy();
  });
  lines.once("close", () => reject(new Error("缺少專案下載設定")));
});
const input = JSON.parse(line);
if (
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo) ||
  !/^[a-f0-9]{40}$/.test(input.sha) ||
  typeof input.token !== "string"
)
  throw new Error("專案下載設定不合法");
const started = Date.now();
const env = {
  ...process.env,
  HOME: "/tmp",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_LFS_SKIP_SMUDGE: "1",
};
const options = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "gc.auto=0",
];
async function run(program, args, extra = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      env,
      ...extra,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => {
      if (out.length < 100000) out += b;
    });
    child.stderr.on("data", (b) => {
      if (err.length < 4000) err += b;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(
            new Error(
              `${program} 執行失敗（${code}）：${err.split(input.token).join("[已隱藏]")}`,
            ),
          ),
    );
  });
}
const git = (args, extra) =>
  run("git", [...options, "--git-dir=/cache/repository", ...args], extra);
try {
  if (readdirSync("/workspace").length || readdirSync("/baseline").length)
    throw new Error("執行副本已存在，請使用新的執行識別碼");
  if (!existsSync("/cache/repository/HEAD"))
    await run("git", [...options, "init", "--bare", "/cache/repository"]);
  // 容器被中止時留下的 Git 鎖，只能在取得跨程序 flock 後清除。
  await run("find", [
    "/cache/repository",
    "-name",
    "*.lock",
    "-type",
    "f",
    "-delete",
  ]);
  await run("find", [
    "/cache/repository/objects/pack",
    "-name",
    "tmp_*",
    "-type",
    "f",
    "-delete",
  ]);
  const present = await git(["cat-file", "-e", `${input.sha}^{commit}`]).then(
    () => true,
    () => false,
  );
  const hadRefs = !!(await git([
    "for-each-ref",
    "--format=%(refname)",
    "refs/agentflow/",
  ]));
  const beforeBytes = Number(
    (await run("du", ["-sb", "/cache/repository/objects"])).split(/\s/)[0],
  );
  const fetchStart = Date.now();
  if (!present) {
    await git(
      [
        "-c",
        "http.lowSpeedLimit=1024",
        "-c",
        "http.lowSpeedTime=60",
        "fetch",
        "--depth=1",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        `https://github.com/${input.repo}.git`,
        input.sha,
      ],
      {
        env: {
          ...env,
          GIT_ASKPASS: "/opt/agentflow/askpass.sh",
          AGENTFLOW_SOURCE_TOKEN: input.token,
        },
      },
    );
  }
  const fetchMs = Date.now() - fetchStart;
  if ((await git(["rev-parse", `${input.sha}^{commit}`])) !== input.sha)
    throw new Error("快取版本與指定基底不一致");
  await git(["update-ref", `refs/agentflow/${input.sha}`, input.sha]);
  const afterBytes = Number(
    (await run("du", ["-sb", "/cache/repository/objects"])).split(/\s/)[0],
  );
  const snapshotStart = Date.now();
  let snapshotHit =
    existsSync("/cache/snapshot-sha") &&
    readFileSync("/cache/snapshot-sha", "utf8") === input.sha;
  if (snapshotHit) {
    // 版本標記不代表檔案完整。快照的樹及工作樹都吻合才可沿用；
    // 升級前沒有樹標記、缺檔、內容改壞或 Git 物件損壞都重新建置。
    try {
      const snapshotGit = (args) =>
        run("git", [...options, "-C", "/cache/snapshot", ...args]);
      const expectedTree = readFileSync("/cache/snapshot-tree", "utf8");
      snapshotHit =
        /^[a-f0-9]{40}$/.test(expectedTree) &&
        (await snapshotGit(["rev-parse", "HEAD^{tree}"])) === expectedTree &&
        (await snapshotGit([
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignored=matching",
        ])) === "";
      if (snapshotHit) await snapshotGit(["fsck", "--no-dangling"]);
    } catch {
      snapshotHit = false;
    }
  }
  if (!snapshotHit) {
    rmSync("/cache/staging", { recursive: true, force: true });
    mkdirSync("/cache/staging");
    // git archive 保留封存檔原有的 export-ignore／export-subst 語意，不套用專案濾鏡。
    await new Promise((resolve, reject) => {
      const archive = spawn(
        "git",
        [...options, "--git-dir=/cache/repository", "archive", input.sha],
        { env, stdio: ["ignore", "pipe", "ignore"] },
      );
      const tar = spawn(
        "tar",
        ["-x", "-C", "/cache/staging", "--no-same-owner"],
        { env, stdio: ["pipe", "ignore", "ignore"] },
      );
      const statuses = [];
      const finish = (code) => {
        statuses.push(code);
        if (statuses.length === 2)
          statuses.every((x) => x === 0)
            ? resolve()
            : reject(new Error("專案快照解壓失敗"));
      };
      archive.once("error", reject);
      tar.once("error", reject);
      archive.once("close", finish);
      tar.once("close", finish);
      tar.stdin.on("error", () => {});
      archive.stdout.pipe(tar.stdin);
    });
    const local = (args) =>
      run("git", [...options, "-C", "/cache/staging", ...args]);
    await local(["init", "-q"]);
    // 上游可能刻意追蹤 .gitignore 匹配檔案；封存內容仍全部納入可信基底。
    await local(["add", "-f", "-A"]);
    await local([
      "-c",
      "user.name=LINE-AgentFlow",
      "-c",
      "user.email=agentflow@localhost",
      "commit",
      "--allow-empty",
      "-qm",
      "記錄工作基底",
    ]);
    const snapshotTree = await local(["rev-parse", "HEAD^{tree}"]);
    // 先移除標記再替換；中斷後必定重新建立，不會把半成品當成命中。
    rmSync("/cache/snapshot-sha", { force: true });
    rmSync("/cache/snapshot", { recursive: true, force: true });
    renameSync("/cache/staging", "/cache/snapshot");
    writeFileSync("/cache/snapshot-tree", snapshotTree);
    writeFileSync("/cache/snapshot-sha", input.sha);
  }
  const snapshotMs = Date.now() - snapshotStart;
  const copyStart = Date.now();
  // 不使用硬連結或共享 .git，工作容器的任何修改都不會污染快取。
  await run("cp", ["-a", "--reflink=auto", "/cache/snapshot/.", "/workspace/"]);
  await run("cp", [
    "-a",
    "--reflink=auto",
    "/cache/snapshot/.git/.",
    "/baseline/",
  ]);
  await run("chown", ["-hR", "1000:1000", "/workspace"]);
  await run("chmod", ["-R", "a+rX", "/baseline"]);
  process.stdout.write(
    JSON.stringify({
      cache: present ? "hit" : hadRefs ? "updated" : "cold",
      sha: input.sha,
      snapshotHit,
      fetchMs,
      snapshotMs,
      copyMs: Date.now() - copyStart,
      totalMs: Date.now() - started,
      addedObjectBytes: Math.max(0, afterBytes - beforeBytes),
    }),
  );
} catch (error) {
  process.stderr.write(
    String(error).split(input.token).join("[已隱藏]").slice(0, 4000),
  );
  process.exitCode = 1;
}
