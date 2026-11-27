import { afterEach, expect, it, vi } from "vitest";
import type { Database } from "../server/db.js";
import { SubscriptionGate } from "../server/subscription-gate.js";
import { subscriptionQuotaHold } from "../shared/subscription-quota.js";

const checkedAt = "2026-02-01T00:00:00Z";
const weeklyReset = "2026-02-06T04:30:00Z";
const shortReset = "2026-02-01T05:00:00Z";
const account = (weekly: number, short = 12, allowed = true) => ({
  allowed,
  checkedAt,
  limits: [
    { windows: [{ usedPercent: short, resetsAt: shortReset }] },
    { windows: [{ usedPercent: weekly, resetsAt: weeklyReset }] },
  ],
});

function gate(
  reserve: number,
  snapshot: { allowed: boolean | null; checkedAt: string },
) {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(checkedAt));
  const db = {
    transaction: (run: (client: unknown) => unknown) =>
      run({
        async query(sql: string) {
          return { rows: sql.includes("FROM settings") ? [{ reserve }] : [] };
        },
      }),
  } as unknown as Database;
  return new SubscriptionGate(db, async () => snapshot);
}

afterEach(() => vi.restoreAllMocks());

it("保留 60% 時，39% 可用，任一視窗達 40% 都會等待", async () => {
  await expect(gate(60, account(39)).ensure()).resolves.toBeUndefined();
  await expect(gate(60, account(40)).ensure()).rejects.toThrow(
    "已用到 chat2pr 可用的上限（保留 60% 給你），預計臺北時間 2/6 12:30 重置",
  );
  await expect(gate(60, account(12, 40)).ensure()).rejects.toThrow(
    "預計臺北時間 2/1 13:00 重置",
  );
});

it("多個視窗達上限時，顯示最晚的重置時間", () => {
  expect(subscriptionQuotaHold(account(40, 42), 60)?.detail).toContain(
    "預計臺北時間 2/6 12:30 重置",
  );
});

it("保留 0% 時沿用帳號許可，無用量資訊也能照常判斷", async () => {
  await expect(gate(0, account(100)).ensure()).resolves.toBeUndefined();
  await expect(
    gate(0, { allowed: true, checkedAt }).ensure(),
  ).resolves.toBeUndefined();
  await expect(gate(0, account(100, 12, false)).ensure()).rejects.toThrow(
    "Codex 訂閱額度已達上限",
  );
});

it("查不到用量時維持無法確認，調低保留比例後可重新通過", async () => {
  await expect(gate(60, { allowed: true, checkedAt }).ensure()).rejects.toThrow(
    "無法確認",
  );
  await expect(gate(0, { allowed: null, checkedAt }).ensure()).rejects.toThrow(
    "無法確認",
  );
  await expect(gate(59, account(40)).ensure()).resolves.toBeUndefined();
});
