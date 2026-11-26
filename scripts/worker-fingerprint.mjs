// 工作程式指紋：worker/ 底下任何檔案變了，就必須升 WORKER_REV（server/containers.ts 與 worker/Dockerfile 的標籤），
// 否則各專案既有的衍生映像會繼續用舊的工作程式（#281 曾漏升，舊版送出的事件被新的白名單丟棄）。
// 用法：改完 worker/ 並升好 WORKER_REV 後執行 `npm run worker:fingerprint` 更新 worker/fingerprint.json。
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = "worker";
const record = join(root, "fingerprint.json");

function files(dir) {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    })
    .filter((path) => path !== record)
    .sort();
}

export function workerFingerprint() {
  const hash = createHash("sha256");
  for (const path of files(root)) {
    // 版本標籤本身不算進指紋；換行統一成 LF，Windows 與 CI 結果一致。
    const text = readFileSync(path, "utf8")
      .replace(/\r\n/g, "\n")
      .replace(/io\.agentflow\.worker-rev="[^"]*"/g, "");
    hash.update(relative(root, path).split(sep).join("/")).update("\0").update(text).update("\0");
  }
  return hash.digest("hex");
}

export function workerRev() {
  return /WORKER_REV = "([^"]+)"/.exec(readFileSync("server/containers.ts", "utf8"))?.[1];
}

export function recordedFingerprint() {
  return JSON.parse(readFileSync(record, "utf8"));
}

if (process.argv[1]?.endsWith("worker-fingerprint.mjs")) {
  const sha = workerFingerprint();
  const rev = workerRev();
  let previous;
  try {
    previous = recordedFingerprint();
  } catch {}
  if (previous && previous.sha !== sha && previous.rev === rev) {
    console.error(`worker/ 有變更，但 WORKER_REV 仍是 ${rev}。請先在 server/containers.ts 與 worker/Dockerfile 升版本號，再執行一次。`);
    process.exit(1);
  }
  writeFileSync(record, JSON.stringify({ rev, sha }, null, 2) + "\n");
  console.log(`已更新 ${record}：${rev} ${sha.slice(0, 12)}`);
}
