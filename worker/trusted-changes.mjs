import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync, closeSync, writeSync } from "node:fs";
import {
  cp,
  lstat,
  readFile,
  realpath,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { assertChangeLimits } from "./change-policy.mjs";

const PREVIEW_BYTES = 150000;
export const REVIEW_EVIDENCE_BYTES = 64 * 1024 * 1024;
const BASE_FILE_BYTES = 32 * 1024 * 1024;
const sha = (data) => createHash("sha256").update(data).digest("hex");
const metadata = (data, mode) =>
  data === null ? null : { bytes: data.length, hash: sha(data), mode };
const isBinary = (data) => {
  if (!data) return false;
  if (data.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return false;
  } catch {
    return true;
  }
};

// 只使用可信基底的 Git metadata；候選內的 .git 不作為基底證據。
async function candidate(options = {}) {
  const workspace = await realpath(options.workspace ?? "/workspace");
  const baseline = options.baseline ?? "/baseline";
  const scratchRoot = options.scratchRoot ?? "/tmp";
  const gitDir = await mkdtemp(path.join(scratchRoot, "agentflow-git-"));
  const args = [
    "--no-replace-objects",
    "--literal-pathspecs",
    `--git-dir=${gitDir}`,
    `--work-tree=${workspace}`,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
  ];
  const git = (more, encoding = "utf8") =>
    execFileSync("git", [...args, ...more], {
      cwd: workspace,
      encoding,
      maxBuffer: BASE_FILE_BYTES,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  try {
    await cp(baseline, gitDir, { recursive: true });
    // 掛載及快照可能讓新舊內容具有相同大小／時間戳；複製來的 index
    // stat 快取不能作為內容未變的證據。保留可信 HEAD，重建空白狀態的索引。
    git(["read-tree", "--empty"]);
    git(["read-tree", "HEAD"]);
    git(["add", "-A"]);
    const names = git([
      "diff",
      "--cached",
      "--name-only",
      "--no-renames",
      "-z",
      "--",
    ])
      .split("\0")
      .filter(Boolean);
    const sizes = [];
    for (const name of names) {
      if (
        path.isAbsolute(name) ||
        name.includes("\\") ||
        name.split("/").some((p) => !p || p === ".." || p === ".") ||
        name.split("/")[0].toLowerCase() === ".git"
      )
        throw new Error("變更路徑不合法");
      const full = path.join(workspace, name);
      let stat;
      try {
        stat = await lstat(full);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (
        stat &&
        (!stat.isFile() ||
          stat.isSymbolicLink() ||
          !(await realpath(full)).startsWith(workspace + path.sep))
      )
        throw new Error("不接受符號連結或特殊檔案變更");
      sizes.push({
        path: name,
        bytes: stat?.size ?? 0,
        deleted: !stat,
        mode: stat && stat.mode & 0o111 ? "100755" : "100644",
      });
    }
    assertChangeLimits(sizes);
    const entries = [];
    let originalBytes = 0;
    for (const item of sizes) {
      const tree = git(["ls-tree", "-z", "HEAD", "--", item.path]);
      let before = null,
        beforeMode = null;
      if (tree) {
        beforeMode = tree.split(" ")[0];
        const size = Number(
          git(["cat-file", "-s", `HEAD:${item.path}`]).trim(),
        );
        if (size > BASE_FILE_BYTES)
          throw new Error("完整審查基底單檔超過 32 MiB，未產生部分差異");
        before = git(["cat-file", "blob", `HEAD:${item.path}`], null);
      }
      const after = item.deleted
        ? null
        : await readFile(path.join(workspace, item.path));
      if (after && after.length !== item.bytes)
        throw new Error("收集期間檔案大小已改變；未發布，請重新驗證候選內容");
      originalBytes += (before?.length ?? 0) + (after?.length ?? 0);
      if (originalBytes > REVIEW_EVIDENCE_BYTES)
        throw new Error("完整審查證據超過 64 MiB，未產生部分差異");
      entries.push({
        path: item.path,
        before,
        after,
        mode: item.mode,
        manifest: {
          path: item.path,
          before: metadata(before, beforeMode),
          after: metadata(after, item.mode),
        },
      });
    }
    return {
      workspace,
      args,
      git,
      entries,
      close: () => rm(gitDir, { recursive: true, force: true }),
    };
  } catch (e) {
    await rm(gitDir, { recursive: true, force: true });
    throw e;
  }
}

/** 預覽只保留有界 bytes，但完整性狀態及全部候選雜湊永遠保留。 */
export async function collectCandidate(options = {}) {
  const current = await candidate(options);
  try {
    const preview = await previewDiff(current);
    return {
      files: current.entries.map((e) => ({
        path: e.path,
        content: e.after?.toString("base64") ?? null,
        mode: e.mode,
      })),
      manifest: current.entries.map((e) => e.manifest),
      stat: current.git(["diff", "--cached", "--stat", "--no-renames", "--"]),
      diff: preview.text,
      diffBytes: preview.bytes,
      diffTruncated: preview.truncated,
    };
  } finally {
    await current.close();
  }
}

function previewDiff(current) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        ...current.args,
        "diff",
        "--cached",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--",
      ],
      {
        cwd: current.workspace,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      },
    );
    const parts = [];
    let bytes = 0,
      saved = 0,
      error = "";
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      const part = chunk.subarray(0, Math.max(0, PREVIEW_BYTES - saved));
      if (part.length) {
        parts.push(part);
        saved += part.length;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (error.length < 2000) error += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve({
            text: Buffer.concat(parts).toString("utf8"),
            bytes,
            truncated: bytes > saved,
          })
        : reject(new Error(`可信差異預覽失敗：${error.slice(0, 2000)}`)),
    );
  });
}

/** 審查前從唯讀快照重算。完整證據留於本階段 tmp，不將大型 patch 疊進成果傳輸。 */
export async function prepareReviewEvidence(expected, options = {}) {
  if (!Array.isArray(expected))
    throw new Error("缺少可信變更清單，不能僅依差異預覽審查");
  const current = await candidate(options);
  try {
    if (
      JSON.stringify(current.entries.map((e) => e.manifest)) !==
      JSON.stringify(expected)
    )
      throw new Error("候選內容與收集紀錄不一致，未啟動審查");
    const directory = await mkdtemp(
      path.join(options.scratchRoot ?? "/tmp", "agentflow-review-"),
    );
    const limit = Math.min(
      options.maxEvidenceBytes ?? REVIEW_EVIDENCE_BYTES,
      REVIEW_EVIDENCE_BYTES,
    );
    let used = 0;
    const charge = (bytes) => {
      used += bytes;
      if (used > limit)
        throw new Error(`完整審查證據超過 ${limit} bytes，未產生部分完整清單`);
    };
    const files = [];
    for (let index = 0; index < current.entries.length; index++) {
      const entry = current.entries[index],
        prefix = String(index + 1).padStart(3, "0");
      const extension = /^\.[a-z0-9]{1,10}$/i.test(path.extname(entry.path))
        ? path.extname(entry.path)
        : ".bin";
      const beforeFile = path.join(directory, `${prefix}-before${extension}`),
        afterFile = path.join(directory, `${prefix}-after${extension}`);
      charge((entry.before?.length ?? 0) + (entry.after?.length ?? 0));
      await writeFile(beforeFile, entry.before ?? Buffer.alloc(0), {
        flag: "wx",
      });
      await writeFile(afterFile, entry.after ?? Buffer.alloc(0), {
        flag: "wx",
      });
      const binary = isBinary(entry.before) || isBinary(entry.after);
      let patch = null;
      if (!binary) {
        const patchPath = path.join(directory, `${prefix}.patch`);
        const result = await completePatch(
          beforeFile,
          afterFile,
          patchPath,
          charge,
        );
        patch = { path: patchPath, ...result };
      }
      files.push({
        ...entry.manifest,
        binary,
        before: entry.manifest.before
          ? { ...entry.manifest.before, file: beforeFile }
          : null,
        after: entry.manifest.after
          ? { ...entry.manifest.after, file: afterFile }
          : null,
        patch,
      });
    }
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = {
      complete: true,
      basis: "readonly-baseline",
      files,
      contentBytes: used,
      evidenceBytes: 0,
      limitBytes: limit,
    };
    // 總數包含清單自身；數字位數穩定後才寫入，不能自述比實際少。
    let serialized = JSON.stringify(manifest, null, 2);
    while (manifest.evidenceBytes !== used + Buffer.byteLength(serialized)) {
      manifest.evidenceBytes = used + Buffer.byteLength(serialized);
      serialized = JSON.stringify(manifest, null, 2);
    }
    charge(Buffer.byteLength(serialized));
    await writeFile(manifestPath, serialized, { flag: "wx" });
    return {
      manifestPath,
      files: files.map(({ path, binary, before, after, patch }) => ({
        path,
        binary,
        before,
        after,
        patch,
      })),
      complete: true,
    };
  } finally {
    await current.close();
  }
}

function completePatch(before, after, destination, charge) {
  return new Promise((resolve, reject) => {
    const descriptor = openSync(destination, "wx"),
      hash = createHash("sha256");
    let bytes = 0,
      failure = null;
    const child = spawn(
      "git",
      [
        "-c",
        "core.attributesFile=/dev/null",
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--text",
        "--no-prefix",
        "--",
        before,
        after,
      ],
      {
        cwd: path.dirname(destination),
        windowsHide: true,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      },
    );
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      try {
        charge(chunk.length);
        bytes += chunk.length;
        hash.update(chunk);
        for (let offset = 0; offset < chunk.length;)
          offset += writeSync(descriptor, chunk, offset, chunk.length - offset);
      } catch (e) {
        failure = e;
        child.kill();
      }
    });
    child.stderr.resume();
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      closeSync(descriptor);
      if (failure) reject(failure);
      else if (code !== 0 && code !== 1)
        reject(new Error("完整可信差異產生失敗，未啟動審查"));
      else resolve({ bytes, hash: hash.digest("hex") });
    });
  });
}
