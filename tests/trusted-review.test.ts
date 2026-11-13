import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, utimes } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import {
  collectCandidate,
  prepareReviewEvidence,
} from "../worker/trusted-changes.mjs";

const scratch: string[] = [];
afterEach(async () => {
  for (const root of scratch.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const parent = path.resolve(".local/review-fixtures");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  scratch.push(root);
  const workspace = path.join(root, "workspace"),
    baseline = path.join(root, "baseline");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "view.html"), "<h1>舊文字</h1>\n");
  await writeFile(path.join(workspace, "removed.txt"), "必須顯示被刪除內容\n");
  await writeFile(
    path.join(workspace, "binary.png"),
    Buffer.from([137, 80, 78, 71, 0, 1]),
  );
  await writeFile(path.join(workspace, "[a].html"), "括號檔案的可信舊文字\n");
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
    "固定可信基底",
  ]);
  await cp(path.join(workspace, ".git"), baseline, { recursive: true });
  return { root, workspace, baseline, scratchRoot: root, git };
}

it("大型報告截斷預覽時，仍提供後面程式的完整可信差異；不信任候選 .git", async () => {
  const f = await fixture();
  await mkdir(path.join(f.workspace, "docs"));
  await writeFile(
    path.join(f.workspace, "docs", "aaa.json"),
    JSON.stringify({ data: "驗收資料".repeat(60000) }),
  );
  await writeFile(path.join(f.workspace, "view.html"), "<h1>新文字</h1>\n");
  f.git(["add", "-A"]);
  f.git([
    "-c",
    "user.name=驗收",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-qm",
    "偽造候選基底",
  ]);
  const collected = await collectCandidate(f);
  expect(collected.diffTruncated).toBe(true);
  expect(collected.diff).not.toContain("+<h1>新文字");
  const evidence = await prepareReviewEvidence(collected.manifest, f);
  const manifest = JSON.parse(await readFile(evidence.manifestPath, "utf8"));
  expect(manifest.complete).toBe(true);
  const listedBytes = manifest.files.reduce(
    (sum: number, file: any) =>
      sum +
      (file.before?.bytes ?? 0) +
      (file.after?.bytes ?? 0) +
      (file.patch?.bytes ?? 0),
    0,
  );
  expect(manifest.contentBytes).toBe(listedBytes);
  expect(manifest.evidenceBytes).toBe(
    listedBytes + (await readFile(evidence.manifestPath)).length,
  );
  const view = manifest.files.find((x: any) => x.path === "view.html");
  expect(await readFile(view.patch.path, "utf8")).toContain("-<h1>舊文字</h1>");
  expect(await readFile(view.patch.path, "utf8")).toContain("+<h1>新文字</h1>");
});

it("刪除、新增、真正二進位與惡意 attributes 都列出完整前後證據", async () => {
  const f = await fixture();
  await rm(path.join(f.workspace, "removed.txt"));
  await writeFile(path.join(f.workspace, "new.txt"), "新檔案\n");
  await writeFile(path.join(f.workspace, ".gitattributes"), "*.html -diff\n");
  await writeFile(
    path.join(f.workspace, "view.html"),
    "<h1>敏感邏輯不能藏掉</h1>\n",
  );
  await writeFile(
    path.join(f.workspace, "binary.png"),
    Buffer.from([137, 80, 78, 71, 0, 2]),
  );
  const c = await collectCandidate(f),
    e = await prepareReviewEvidence(c.manifest, f);
  const m = JSON.parse(await readFile(e.manifestPath, "utf8"));
  expect(m.files.find((x: any) => x.path === "removed.txt").after).toBe(null);
  expect(m.files.find((x: any) => x.path === "new.txt").before).toBe(null);
  const binary = m.files.find((x: any) => x.path === "binary.png");
  expect(binary.binary).toBe(true);
  expect(binary.patch).toBe(null);
  expect(await readFile(binary.before.file)).toEqual(
    Buffer.from([137, 80, 78, 71, 0, 1]),
  );
  expect(await readFile(binary.after.file)).toEqual(
    Buffer.from([137, 80, 78, 71, 0, 2]),
  );
  const view = m.files.find((x: any) => x.path === "view.html");
  expect(await readFile(view.patch.path, "utf8")).toContain(
    "+<h1>敏感邏輯不能藏掉",
  );
});

it("候選收集後變動或缺完整 manifest 時拒絕審查，不能用截斷預覽替代", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, "view.html"), "第一次\n");
  const c = await collectCandidate(f);
  await writeFile(path.join(f.workspace, "view.html"), "晚到變更\n");
  await expect(prepareReviewEvidence(c.manifest, f)).rejects.toThrow(
    "候選內容與收集紀錄不一致",
  );
  await expect(prepareReviewEvidence(undefined, f)).rejects.toThrow(
    "缺少可信變更清單",
  );
});

it("證據超限必須停止，不產生 complete 的部分 manifest", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, "view.html"), "資料".repeat(200));
  const c = await collectCandidate(f);
  await expect(
    prepareReviewEvidence(c.manifest, { ...f, maxEvidenceBytes: 100 }),
  ).rejects.toThrow("完整審查證據超過");
});

it("特殊檔名以完整字面路徑讀取基底，重新命名仍同時保留刪除與新增", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, "[a].html"), "括號檔案的新文字\n");
  await writeFile(
    path.join(f.workspace, "renamed.txt"),
    await readFile(path.join(f.workspace, "removed.txt")),
  );
  await rm(path.join(f.workspace, "removed.txt"));
  const c = await collectCandidate(f);
  expect(c.manifest.find((e) => e.path === "[a].html")?.before).not.toBe(null);
  expect(c.manifest.find((e) => e.path === "removed.txt")?.after).toBe(null);
  expect(c.manifest.find((e) => e.path === "renamed.txt")?.before).toBe(null);
  const e = await prepareReviewEvidence(c.manifest, f);
  const item = e.files.find((file) => file.path === "[a].html")!;
  expect(await readFile(item.before!.file, "utf8")).toBe(
    "括號檔案的可信舊文字\n",
  );
});

it("同長度與時間戳的候選也重算內容，不信任基底 index 的檔案狀態快取", async () => {
  const f = await fixture();
  const file = path.join(f.workspace, "view.html");
  const fixedTime = new Date("2020-01-01T00:00:00Z");
  f.git(["config", "core.trustctime", "false"]);
  f.git(["config", "core.checkStat", "minimal"]);
  await utimes(file, fixedTime, fixedTime);
  f.git(["add", "-A"]);
  await cp(path.join(f.workspace, ".git"), f.baseline, { recursive: true });
  await writeFile(file, "<h1>新文字</h1>\n");
  await utimes(file, fixedTime, fixedTime);
  const collected = await collectCandidate(f);
  expect(collected.manifest.map(e => e.path)).toContain("view.html");
  const evidence = await prepareReviewEvidence(collected.manifest, f);
  const changed = evidence.files.find(e => e.path === "view.html")!;
  expect(await readFile(changed.patch!.path, "utf8")).toContain("+<h1>新文字</h1>");
});

it("真容器在唯讀基底與唯讀候選掛載中仍能產生完整證據", async () => {
  const f = await fixture();
  await mkdir(path.join(f.workspace, "docs"));
  await writeFile(
    path.join(f.workspace, "docs", "aaa.json"),
    JSON.stringify({ matrix: "全部情境量測".repeat(40000) }),
  );
  await writeFile(path.join(f.workspace, "view.html"), "<h1>新文字</h1>\n");
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=128m,mode=1777",
      "-v",
      `${f.workspace}:/workspace:ro`,
      "-v",
      `${f.baseline}:/baseline:ro`,
      "-v",
      `${path.resolve("worker")}:/opt/agentflow:ro`,
      "--entrypoint",
      "node",
      process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
      "--input-type=module",
      "-e",
      `import{collectCandidate,prepareReviewEvidence}from'/opt/agentflow/trusted-changes.mjs';import fs from'node:fs/promises';
const c=await collectCandidate(),e=await prepareReviewEvidence(c.manifest);const m=JSON.parse(await fs.readFile(e.manifestPath,'utf8'));const v=m.files.find(x=>x.path==='view.html');
let blocked=0;for(const file of ['/workspace/view.html','/baseline/config'])try{await fs.writeFile(file,'不能寫入');}catch(error){if(error.code==='EROFS'||error.code==='EACCES')blocked++;else throw error;}
console.log(JSON.stringify({complete:m.complete,truncated:c.diffTruncated,blocked,patch:await fs.readFile(v.patch.path,'utf8')}));`,
    ],
    { encoding: "utf8", maxBuffer: 100000, windowsHide: true },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({ complete: true, truncated: true, blocked: 2 });
  expect(report.patch).toContain("-<h1>舊文字</h1>");
  expect(report.patch).toContain("+<h1>新文字</h1>");
}, 30000);
