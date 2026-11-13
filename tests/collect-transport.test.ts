import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { Containers, COLLECT_OUTPUT_BYTES } from "../server/containers.js";

const worker =
  process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local";

it("真容器的 9.5 MiB 成果可完整通過 collect 傳輸，base64 與雜湊一致", async () => {
  const c = new Containers(`verify-collect-${randomUUID().slice(0, 8)}`),
    id = randomUUID();
  try {
    await c.prepare(
      id,
      worker,
      execFileSync("git", [
        "archive",
        "--format=tar",
        "--prefix=fixture/",
        "HEAD",
        "README.md",
      ]),
    );
    const created = await c.phase(id, worker, [
      "node",
      "-e",
      `const fs=require('fs'),crypto=require('crypto');const data=crypto.randomBytes(9.5*1024*1024);fs.writeFileSync('large.png',data);console.log(crypto.createHash('sha256').update(data).digest('hex'))`,
    ]);
    expect(created.exitCode).toBe(0);
    const result = await c.phase(
      id,
      worker,
      ["node", "/opt/agentflow/collect.mjs"],
      "none",
      undefined,
      30000,
      false,
      true,
      undefined,
      { output: "collect" },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(12 * 1024 * 1024);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(COLLECT_OUTPUT_BYTES);
    const changes = JSON.parse(result.stdout);
    expect(changes.files).toHaveLength(1);
    const file = changes.files[0];
    expect(file.path).toBe("large.png");
    const data = Buffer.from(file.content, "base64");
    expect(data.length).toBe(9.5 * 1024 * 1024);
    expect(createHash("sha256").update(data).digest("hex")).toBe(
      created.stdout.trim(),
    );
  } finally {
    await c.dispose(id);
  }
}, 60000);

it("collect 的 UTF-8 多位元字元跨 chunk 完整，超過 16 MiB 明確 413 並清理", async () => {
  const c = new Containers(`verify-collect-${randomUUID().slice(0, 8)}`),
    id = randomUUID();
  try {
    const text = "繁體中文🦋".repeat(100000);
    const result = await c.phase(
      id,
      worker,
      [
        "node",
        "-e",
        `const s=JSON.stringify('繁體中文🦋'.repeat(100000)),b=Buffer.from(s);for(let n=0;n<b.length;n+=8191)process.stdout.write(b.subarray(n,n+8191))`,
      ],
      "none",
      undefined,
      30000,
      false,
      false,
      undefined,
      { output: "collect" },
    );
    expect(JSON.parse(result.stdout)).toBe(text);
    await expect(
      c.phase(
        id,
        worker,
        ["node", "-e", `process.stdout.write('中'.repeat(6*1024*1024))`],
        "none",
        undefined,
        30000,
        false,
        false,
        undefined,
        { output: "collect" },
      ),
    ).rejects.toMatchObject({
      statusCode: 413,
      message: "成果收集輸出超過 16 MiB 傳輸上限，未回傳截斷成果",
    });
    expect(
      await c.docker.listContainers({
        all: true,
        filters: JSON.stringify({
          label: [`io.agentflow.instance=${c.instance}`],
        }),
      }),
    ).toHaveLength(0);
  } finally {
    await c.dispose(id);
  }
}, 60000);
