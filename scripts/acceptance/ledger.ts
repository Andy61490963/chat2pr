import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { redact } from "../../server/policy.js";
import { instanceName } from "../../server/config.js";

export const CaseSpec = z
  .object({
    id: z.string().regex(/^[A-Z][A-Z0-9]*-?\d{2,3}(?:\.[a-z][a-z0-9-]*)?$/),
    title: z.string().min(1).max(200),
    environment: z.enum(["isolated", "line-live"]),
    evidenceKind: z.enum([
      "deterministic",
      "real-model",
      "real-line",
      "browser",
    ]),
    expected: z.array(z.string().min(1).max(1000)).min(1),
    required: z.boolean().default(true),
  })
  .strict();
export const Manifest = z
  .object({
    version: z.literal(1),
    suiteId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
    // 驗收用的測試儲存庫，由 ACCEPTANCE_REPO 指定（擁有者/儲存庫）。
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    baselineSha: z.string().regex(/^[a-f0-9]{40}$/),
    createdAt: z.iso.datetime(),
    cases: z.array(CaseSpec).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.cases.map((c) => c.id)).size !== value.cases.length)
      ctx.addIssue({ code: "custom", message: "案例識別碼不能重複" });
  });
export type Manifest = z.infer<typeof Manifest>;
const References = z
  .object({
    taskId: z.string().uuid().optional(),
    runId: z.string().uuid().optional(),
    threadId: z.string().max(100).optional(),
    issue: z.number().int().positive().optional(),
    pr: z.number().int().positive().optional(),
    headSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
  })
  .strict();
const Artifact = z
  .object({
    path: z.string().min(1).max(1000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const RecordInput = z
  .object({
    caseId: CaseSpec.shape.id,
    attempt: z.number().int().positive(),
    status: z.enum([
      "started",
      "checkpoint",
      "passed",
      "failed",
      "blocked",
      "reconciled",
    ]),
    detail: z.string().max(10000).default(""),
    references: References.default({}),
    artifacts: z.array(Artifact).max(30).default([]),
  })
  .strict();
export type RecordInput = z.input<typeof RecordInput>;
const Entry = RecordInput.extend({
  sequence: z.number().int().positive(),
  at: z.iso.datetime(),
  environment: CaseSpec.shape.environment,
  evidenceKind: CaseSpec.shape.evidenceKind,
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type LedgerEntry = z.infer<typeof Entry>;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const terminal = new Set(["passed", "failed", "blocked"]);

/** 單一套件可續跑；所有結果採附加與 fsync，不覆寫第一輪失敗。 */
export class AcceptanceLedger {
  private constructor(
    readonly directory: string,
    readonly manifest: Manifest,
    readonly manifestHash: string,
  ) {}
  static async open(root: string, input: Manifest) {
    const manifest = Manifest.parse(input);
    instanceName(`verify-${manifest.suiteId}`);
    const directory = resolve(root, `verify-${manifest.suiteId}`);
    await mkdir(directory, { recursive: true });
    const encoded = JSON.stringify(manifest, null, 2) + "\n";
    const path = join(directory, "manifest.json");
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(encoded);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await readFile(path, "utf8")) !== encoded)
        throw new Error(
          "套件識別碼已有不同 manifest；請使用新的 suiteId，不能覆寫驗收歷史",
        );
    }
    return new AcceptanceLedger(directory, manifest, hash(encoded));
  }
  async entries(): Promise<LedgerEntry[]> {
    let text: string;
    try {
      text = await readFile(join(this.directory, "ledger.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (text && !text.endsWith("\n"))
      throw new Error(
        "驗收紀錄最後一列不完整，必須保留原檔並人工核對；禁止靜默略過",
      );
    const rows = text
      .split("\n")
      .filter(Boolean)
      .map((line) => Entry.parse(JSON.parse(line)));
    rows.forEach((row, index) => {
      const spec = this.manifest.cases.find((c) => c.id === row.caseId);
      if (
        row.sequence !== index + 1 ||
        row.manifestHash !== this.manifestHash ||
        !spec ||
        row.environment !== spec.environment ||
        row.evidenceKind !== spec.evidenceKind
      )
        throw new Error("驗收紀錄與 manifest 或序號不一致，必須先核對");
    });
    return rows;
  }
  async append(input: RecordInput): Promise<LedgerEntry> {
    const value = RecordInput.parse(input),
      spec = this.manifest.cases.find((c) => c.id === value.caseId);
    if (!spec) throw new Error("案例未列入 manifest");
    const lockPath = join(this.directory, "ledger.lock");
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("驗收紀錄已有寫入者或中斷鎖，必須先核對，不可重複執行");
      throw error;
    }
    try {
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      );
      const previous = await this.entries();
      const attempts = previous.filter((r) => r.caseId === value.caseId);
      const current = attempts.filter((r) => r.attempt === value.attempt),
        last = current.at(-1);
      const max = Math.max(0, ...attempts.map((r) => r.attempt));
      if (value.status === "started") {
        if (
          value.attempt !== max + 1 ||
          (max > 0 && !terminal.has(attempts.at(-1)!.status))
        )
          throw new Error("前次執行尚未核對結束，禁止開始另一輪");
      } else if (value.status === "reconciled") {
        if (!last || !["started", "checkpoint"].includes(last.status))
          throw new Error("只有中斷中的執行需要核對");
      } else if (!last || terminal.has(last.status) || value.attempt !== max)
        throw new Error("必須先開始此輪，已結束的結果不能覆寫");
      const entry: LedgerEntry = {
        ...value,
        detail: redact(value.detail),
        sequence: previous.length + 1,
        at: new Date().toISOString(),
        environment: spec.environment,
        evidenceKind: spec.evidenceKind,
        manifestHash: this.manifestHash,
      };
      const file = await open(join(this.directory, "ledger.jsonl"), "a", 0o600);
      try {
        await file.writeFile(JSON.stringify(entry) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      return entry;
    } finally {
      await lock.close();
      const { unlink } = await import("node:fs/promises");
      await unlink(lockPath);
    }
  }
  async summary() {
    const rows = await this.entries();
    return this.manifest.cases.map((spec) => {
      const entries = rows.filter((r) => r.caseId === spec.id);
      const results = entries.filter((r) => terminal.has(r.status));
      const last = entries.at(-1);
      return {
        ...spec,
        firstResult: results[0] ?? null,
        firstFailure:
          results.find(
            (r) => r.status === "failed" || r.status === "blocked",
          ) ?? null,
        latestResult: results.at(-1) ?? null,
        attempts: Math.max(0, ...entries.map((r) => r.attempt)),
        resume: !last
          ? "ready"
          : last.status === "passed"
            ? "complete"
            : ["failed", "blocked"].includes(last.status)
              ? "retry-explicitly"
              : "reconcile-required",
      };
    });
  }
}
