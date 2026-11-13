import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// 不使用工作派送 runner；每次只在無網路、全新 tmpfs 中執行目前版本的真 collector。
function collectFixture(mode: string) {
  const script = `
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
const mode=process.argv[2];
const git=(args)=>execFileSync('git',['-C','/workspace','-c','core.hooksPath=/dev/null',...args],{encoding:'utf8'});
await fs.writeFile('/workspace/base.txt','基底不可改寫');
git(['init','-q']);git(['add','-A']);git(['-c','user.name=驗收','-c','user.email=test@localhost','commit','-qm','記錄測試基底']);
await fs.cp('/workspace/.git','/baseline',{recursive:true});
const fingerprints=[];
async function file(name,bytes){await fs.writeFile('/workspace/'+name,bytes);fingerprints.push({name,hash:crypto.createHash('sha256').update(bytes).digest('hex')});}
if(mode==='exact')await file('image.bin',crypto.randomBytes(10*1024*1024));
else if(mode==='size')for(let i=0;i<6;i++)await file('large-'+i+'.png',Buffer.alloc(2*1024*1024,i));
else if(mode==='count')for(let i=0;i<201;i++)await file('case-'+i+'.txt',Buffer.from('測試'));
else if(mode==='mode')await fs.chmod('/workspace/base.txt',0o755);
else throw Error('未知案例');
const result=spawnSync('node',['/opt/agentflow/collect.mjs'],{encoding:'utf8',maxBuffer:16*1024*1024});
if(result.error)throw result.error;
for(const item of fingerprints)if(crypto.createHash('sha256').update(await fs.readFile('/workspace/'+item.name)).digest('hex')!==item.hash)throw Error('收集器改動或刪除候選');
let parsed=null;if(result.status===0){const body=JSON.parse(result.stdout);parsed={files:body.files.length,bytes:Buffer.from(body.files[0].content,'base64').length,contentHash:crypto.createHash('sha256').update(Buffer.from(body.files[0].content,'base64')).digest('hex'),manifest:body.manifest};if(mode!=='mode'&&parsed.contentHash!==fingerprints[0].hash)throw Error('回傳內容與實體候選不符');if(mode==='mode'){const {prepareReviewEvidence}=await import('/opt/agentflow/trusted-changes.mjs');const evidence=await prepareReviewEvidence(body.manifest);parsed.evidence=JSON.parse(await fs.readFile(evidence.manifestPath,'utf8'));}}
process.stdout.write(JSON.stringify({status:result.status,stdoutBytes:Buffer.byteLength(result.stdout),stderr:result.stderr,parsed,candidatesUnchanged:true}));
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
      `${resolve("worker")}:/opt/agentflow:ro`,
      "--entrypoint",
      "node",
      process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
      "--input-type=module",
      "-",
      mode,
    ],
    {
      input: script,
      encoding: "utf8",
      maxBuffer: 32 * 1024,
      windowsHide: true,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

it("真收集器接受剛好 10 MiB，base64 完整可還原且不改候選", () => {
  const result = collectFixture("exact");
  expect(result.status, result.stderr).toBe(0);
  expect(result.parsed).toMatchObject({ files: 1, bytes: 10 * 1024 * 1024 });
  expect(result.stdoutBytes).toBeGreaterThan(12 * 1024 * 1024);
  expect(result.stdoutBytes).toBeLessThan(16 * 1024 * 1024);
  expect(result.candidatesUnchanged).toBe(true);
}, 30000);

it("真收集器先統計全部超限檔案，診斷有總量及最多十個大檔且不刪圖", () => {
  const result = collectFixture("size");
  expect(result.status).not.toBe(0);
  expect(result.stdoutBytes).toBe(0);
  expect(result.stderr).toContain("12582912 bytes");
  expect(result.stderr).toContain("6 個檔案");
  expect(result.stderr).toContain("10 MiB（10485760 bytes）");
  expect(result.stderr).toContain("最大 6 個檔案");
  expect(result.stderr).toContain('"large-0.png"：2097152 bytes');
  expect(result.stderr).toContain('"large-5.png"：2097152 bytes');
  expect(result.stderr).toContain("未刪除任何檔案、未發布");
  expect(result.stderr.length).toBeLessThan(2500);
  expect(result.candidatesUnchanged).toBe(true);
}, 30000);

it("真收集器拒絕 201 檔並回報完整檔數與 bytes，不提高既有門檻", () => {
  const result = collectFixture("count");
  expect(result.status).not.toBe(0);
  expect(result.stdoutBytes).toBe(0);
  expect(result.stderr).toContain("檔案數 201 超過 200 個檔案上限");
  expect(result.stderr).toContain("201 個檔案、1206 bytes");
  expect(result.stderr).toContain("未刪除任何檔案、未發布");
  expect(result.candidatesUnchanged).toBe(true);
}, 30000);

it("Linux 真容器的純執行模式變更保留在可信清單與完整審查證據", () => {
  const result = collectFixture("mode");
  expect(result.status, result.stderr).toBe(0);
  expect(result.parsed.manifest).toMatchObject([
    { path: "base.txt", before: { mode: "100644" }, after: { mode: "100755" } },
  ]);
  expect(result.parsed.evidence.complete).toBe(true);
  expect(result.parsed.evidence.files[0]).toMatchObject({
    path: "base.txt",
    before: { mode: "100644" },
    after: { mode: "100755" },
    patch: { bytes: 0 },
  });
}, 30000);
