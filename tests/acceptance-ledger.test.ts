import { it, expect } from "vitest";
import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AcceptanceLedger,
  type Manifest,
} from "../scripts/acceptance/ledger.js";

it("驗收 ledger 保留第一輪失敗、嚴格續跑與證據環境，不能把重跑成功洗成首輪通過", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentflow-ledger-"));
  const manifest: Manifest = {
    version: 1,
    suiteId: "ledger",
    repo: "example-org/test",
    baselineSha: "a".repeat(40),
    createdAt: new Date().toISOString(),
    cases: [
      {
        id: "ISO-01",
        title: "取消隔離",
        environment: "isolated",
        evidenceKind: "deterministic",
        expected: ["另一個執行器持續工作"],
        required: true,
      },
    ],
  };
  try {
    const ledger = await AcceptanceLedger.open(root, manifest);
    expect((await ledger.summary())[0].resume).toBe("ready");
    await ledger.append({ caseId: "ISO-01", attempt: 1, status: "started" });
    await expect(
      ledger.append({ caseId: "ISO-01", attempt: 2, status: "started" }),
    ).rejects.toThrow("尚未核對");
    expect((await ledger.summary())[0].resume).toBe("reconcile-required");
    await ledger.append({
      caseId: "ISO-01",
      attempt: 1,
      status: "reconciled",
      detail: "遠端沒有建立 PR",
    });
    await ledger.append({
      caseId: "ISO-01",
      attempt: 1,
      status: "failed",
      detail: "連線失敗 sk-12345678901234567890",
    });
    await expect(
      ledger.append({ caseId: "ISO-01", attempt: 1, status: "passed" }),
    ).rejects.toThrow("不能覆寫");
    const resumed = await AcceptanceLedger.open(root, manifest);
    await resumed.append({ caseId: "ISO-01", attempt: 2, status: "started" });
    await resumed.append({ caseId: "ISO-01", attempt: 2, status: "passed" });
    const summary = (await resumed.summary())[0];
    expect(summary.firstResult?.status).toBe("failed");
    expect(summary.firstFailure?.detail).not.toContain("sk-");
    expect(summary.latestResult?.status).toBe("passed");
    expect(summary.attempts).toBe(2);
    expect(summary.resume).toBe("complete");
    expect(summary.environment).toBe("isolated");
    await expect(
      AcceptanceLedger.open(root, { ...manifest, baselineSha: "b".repeat(40) }),
    ).rejects.toThrow("不同 manifest");
    await appendFile(join(ledger.directory, "ledger.jsonl"), '{"中斷":');
    await expect(ledger.entries()).rejects.toThrow("不完整");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
