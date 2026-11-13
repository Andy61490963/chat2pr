import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type Docker from "dockerode";
import { Containers, WORKER_REV } from "../server/containers.js";

function withLabels(labels: Record<string, string>) {
  const c = new Containers("verify-worker-rev");
  vi.spyOn(c.docker, "getImage").mockReturnValue({
    inspect: async () => ({ Id: "sha256:fake", Config: { Labels: labels } }),
  } as unknown as Docker.Image);
  return c;
}

it("工作映像版本過舊或未標示時拒絕，避免專案默默使用舊的工作程式", async () => {
  await expect(
    withLabels({ "io.agentflow.worker": "v1" }).ready("old:image"),
  ).rejects.toThrow("版本過舊");
  await expect(
    withLabels({
      "io.agentflow.worker": "v1",
      "io.agentflow.worker-rev": "2026-11-01",
    }).ready("old:image"),
  ).rejects.toThrow("需要 " + WORKER_REV);
  await expect(
    withLabels({
      "io.agentflow.worker": "v1",
      "io.agentflow.worker-rev": WORKER_REV,
    }).ready("new:image"),
  ).resolves.toBe("sha256:fake");
});

it("Dockerfile 的版本標記與執行器要求一致", () => {
  const dockerfile = readFileSync("worker/Dockerfile", "utf8");
  expect(dockerfile).toContain(`io.agentflow.worker-rev="${WORKER_REV}"`);
});
