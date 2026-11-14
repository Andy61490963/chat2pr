import { describe, expect, it } from "vitest";
import {
  checkEnvironmentKey,
  checkEnvironmentPolicy,
  environmentsToRemove,
  environmentView,
  type KeptEnvironment,
} from "../shared/check-environment.js";
import { subnetSlot, viaHostGateway } from "../server/check-environments.js";

const now = Date.parse("2026-11-14T12:00:00Z");
const minutesAgo = (m: number) => new Date(now - m * 60000).toISOString();
const kept = (checkId: string, key: string, idle: number): KeptEnvironment => ({
  checkId,
  key,
  createdAt: minutesAgo(idle + 10),
  lastUsedAt: minutesAgo(idle),
});
const policy = { idleMinutes: 120, max: 3 };

describe("檢查環境的保留與清除規則（#19）", () => {
  it("預設閒置 2 小時、最多 20 個；設定超出範圍時取邊界", () => {
    expect(checkEnvironmentPolicy({})).toEqual({ idleMinutes: 120, max: 20 });
    expect(
      checkEnvironmentPolicy({ check_env_idle_minutes: 1, check_env_max: 999 }),
    ).toEqual({ idleMinutes: 10, max: 100 });
  });

  it("環境鍵由檢查版本與 SQL 連線版本組成；HTTP／TCP 不看連線", () => {
    const conn = {
      updated_at: "2026-11-01T00:00:00Z",
      ssh_host_key: null,
    };
    expect(checkEnvironmentKey({ version: 2, kind: "http" }, conn)).toBe("v2");
    const sql = checkEnvironmentKey({ version: 2, kind: "sql" }, conn);
    expect(sql).toMatch(/^v2\.c\d+\.n$/);
    expect(
      checkEnvironmentKey(
        { version: 2, kind: "sql" },
        { ...conn, ssh_host_key: "SHA256:fictional" },
      ),
    ).not.toBe(sql);
  });

  it("清單外或鍵不同 → 立即清；閒置逾時 → 清；其餘超過上限時先清最久沒用的", () => {
    const envs = [
      kept("a", "v1", 5),
      kept("b", "v1", 130),
      kept("c", "v1", 60),
      kept("d", "v1", 30),
      kept("e", "v2", 1),
      kept("f", "v1", 90),
    ];
    const valid = new Map([
      ["a", "v1"],
      ["b", "v1"],
      ["c", "v1"],
      ["d", "v1"],
      ["e", "v3"],
      ["f", "v1"],
    ]);
    expect(environmentsToRemove(envs, valid, policy, now)).toEqual([
      { checkId: "b", reason: "idle" },
      { checkId: "e", reason: "stale" },
      { checkId: "f", reason: "limit" },
    ]);
    // 建立新環境前先騰出一個位置。
    expect(
      environmentsToRemove(envs.slice(0, 4), null, policy, now, 1).map(
        (r) => r.checkId,
      ),
    ).toEqual(["b", "c"]);
  });

  it("看板狀態：保留中附預計清除時間；鍵不同時視為未建立；建立失敗附原因", () => {
    const e = kept("a", "v1", 30);
    expect(environmentView("v1", e, undefined, policy)).toEqual({
      state: "kept",
      createdAt: e.createdAt,
      lastUsedAt: e.lastUsedAt,
      expiresAt: new Date(now + 90 * 60000).toISOString(),
    });
    expect(environmentView("v2", e, undefined, policy)).toEqual({
      state: "none",
    });
    expect(
      environmentView(
        "v2",
        undefined,
        { checkId: "a", key: "v2", at: minutesAgo(1), message: "找不到映像" },
        policy,
      ),
    ).toMatchObject({ state: "failed", message: "找不到映像" });
  });

  it("專用網路從自己的位址池切 /28，不佔 Docker 預設位址池", () => {
    expect(subnetSlot("10.213.0.0/16", 0)).toBe("10.213.0.0/28");
    expect(subnetSlot("10.213.0.0/16", 17)).toBe("10.213.1.16/28");
    expect(subnetSlot("10.213.0.0/16", 4095)).toBe("10.213.255.240/28");
    expect(subnetSlot("10.213.0.0/16", 4096)).toBeUndefined();
    expect(subnetSlot("10.219.0.0/24", 15)).toBe("10.219.0.240/28");
    expect(subnetSlot("bad", 0)).toBeUndefined();
  });

  it("登記在主機本身的資料庫改經 Docker 主機閘道連線", () => {
    expect(viaHostGateway("localhost")).toBe("host.docker.internal");
    expect(viaHostGateway("127.0.0.1")).toBe("host.docker.internal");
    expect(viaHostGateway("db.example.test")).toBe("db.example.test");
  });
});
