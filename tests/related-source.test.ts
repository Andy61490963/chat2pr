import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { buffer } from "node:stream/consumers";
import { pack } from "tar-stream";
import { Containers } from "../server/containers.js";

const image =
  process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local";

/** 模擬 GitHub tarball：頂層目錄為「擁有者-儲存庫-版本」。 */
async function tarball() {
  const archive = pack();
  archive.entry(
    { name: "Org-MachineSync-abc123/src/StatusChange.cs" },
    "public class StatusChange { public string EqmNo; }",
  );
  archive.finalize();
  return gzipSync(await buffer(archive as unknown as AsyncIterable<Buffer>));
}

describe("跨專案查詢的相關專案原始碼", () => {
  it("解開在環境資料卷，工作容器可讀但不能改", async () => {
    const c = new Containers(),
      id = randomUUID();
    await c.ensureVolume(c.volume(id), id);
    try {
      await c.provideArchive(
        id,
        image,
        "projects/MachineSync",
        await tarball(),
      );
      const r = await c.phase(id, image, [
        "sh",
        "-c",
        "cat /agentflow/env/projects/MachineSync/src/StatusChange.cs; if echo x > /agentflow/env/projects/MachineSync/new.txt 2>/dev/null; then echo WRITABLE; fi; id -u",
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("public class StatusChange");
      expect(r.stdout).not.toContain("WRITABLE");
      expect(r.stdout.trim().endsWith("1000")).toBe(true);
    } finally {
      await c.dispose(id);
    }
  }, 120000);
  it("拒絕跳出環境目錄的名稱", async () => {
    const c = new Containers();
    await expect(
      c.provideArchive(
        randomUUID(),
        image,
        "projects/../../etc",
        Buffer.from(""),
      ),
    ).rejects.toThrow("目錄名稱無效");
  });
});
