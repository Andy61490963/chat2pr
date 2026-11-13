import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("真容器退出前收集報告圖片，拒絕越界、符號連結、硬連結與超大檔案", () => {
  const script = `
import fs from 'node:fs/promises';
import {collectReportImages,reportDirectory} from '/opt/agentflow/query-report.mjs';
await fs.mkdir(reportDirectory,{recursive:true});
await fs.writeFile('/tmp/outside.png','外部內容');
await fs.writeFile(reportDirectory+'/good.png','圖片位元組');
const results={};
async function check(name,file) {
 await fs.writeFile(reportDirectory+'/manifest.json',JSON.stringify([{key:'img-1',file,caption:'圖說',kind:'repository',source:'docs/view.png'}]));
 const result=await collectReportImages();
 results[name]={count:result.images.length,warnings:result.warnings.length};
}
await check('normal','good.png');
await check('escape','../outside.png');
await fs.symlink('/tmp/outside.png',reportDirectory+'/link.png');
await check('symlink','link.png');
await fs.link('/tmp/outside.png',reportDirectory+'/hard.png');
await check('hardlink','hard.png');
await fs.writeFile(reportDirectory+'/large.png',Buffer.alloc(2097153));
await check('oversize','large.png');
await fs.unlink(reportDirectory+'/manifest.json');
await fs.symlink('/tmp/outside.png',reportDirectory+'/manifest.json');
const linkedManifest=await collectReportImages();results.manifest={count:linkedManifest.images.length,warnings:linkedManifest.warnings.length};
process.stdout.write(JSON.stringify(results));
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
      "/tmp:rw,size=16m,mode=1777",
      "-v",
      `${resolve("worker")}:/opt/agentflow:ro`,
      "--entrypoint",
      "node",
      process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local",
      "--input-type=module",
      "-",
    ],
    { input: script, encoding: "utf8", windowsHide: true },
  );
  expect(result.status, result.stderr).toBe(0);
  const values = JSON.parse(result.stdout);
  expect(values.normal).toEqual({ count: 1, warnings: 0 });
  for (const key of ["escape", "symlink", "hardlink", "oversize", "manifest"])
    expect(values[key]).toEqual({ count: 0, warnings: 1 });
});
