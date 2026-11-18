import { describe, expect, it } from "vitest";
import {
  MEMORY_FLOOR_MB,
  MEMORY_RESUME_MB,
  memoryHold,
  parseMeminfo,
  withVmMemory,
} from "../server/capacity.js";

// 不需要資料庫：Docker（WSL2）VM 可用記憶體只量測與顯示，暫停判斷仍看 Windows（項目 18）。
const sample = `MemTotal:       16303716 kB
MemFree:         1048576 kB
MemAvailable:    6291456 kB
Buffers:          123456 kB
Cached:          4567890 kB
SwapTotal:       4194304 kB
`;

describe("解析 /proc/meminfo", () => {
  it("正常：總量取 MemTotal，可用量優先取 MemAvailable", () => {
    expect(parseMeminfo(sample)).toEqual({
      vmTotalMb: Math.round(16303716 / 1024),
      vmAvailMb: 6144,
    });
  });

  it("沒有 MemAvailable 的舊核心退回 MemFree", () => {
    expect(
      parseMeminfo("MemTotal: 8388608 kB\nMemFree:  2097152 kB\n"),
    ).toEqual({ vmTotalMb: 8192, vmAvailMb: 2048 });
  });

  it("缺欄位就不填，不猜測", () => {
    expect(parseMeminfo("MemTotal: 8388608 kB\n")).toEqual({
      vmTotalMb: 8192,
    });
    expect(parseMeminfo("MemAvailable: 2097152 kB\n")).toEqual({
      vmAvailMb: 2048,
    });
    expect(parseMeminfo("")).toEqual({});
  });

  it("格式不符（沒有單位、單位不是 kB、不是數字、欄位名稱只有前綴相同）不填", () => {
    expect(parseMeminfo("MemTotal: 8388608\nMemAvailable: 2097152\n")).toEqual(
      {},
    );
    expect(
      parseMeminfo("MemTotal: 8388608 MB\nMemAvailable: 2097152 MB\n"),
    ).toEqual({});
    expect(parseMeminfo("MemTotal: abc kB\nMemAvailable: -1 kB\n")).toEqual({});
    expect(parseMeminfo("XMemTotal: 8388608 kB\nMemTotalX: 1 kB\n")).toEqual(
      {},
    );
    expect(parseMeminfo("not meminfo at all")).toEqual({});
  });

  it("可用量大於總量的讀數不可信，不填可用量", () => {
    expect(
      parseMeminfo("MemTotal: 1048576 kB\nMemAvailable: 2097152 kB\n"),
    ).toEqual({ vmTotalMb: 1024 });
  });

  it("讀不到 /proc/meminfo 時保留原本的 Windows 數字", async () => {
    const host = { cpus: 8, memTotalMb: 16384, memFreeMb: 4096 };
    expect(
      await withVmMemory(host, async () => {
        throw new Error("ENOENT");
      }),
    ).toEqual(host);
    expect(await withVmMemory(host, async () => sample)).toEqual({
      ...host,
      vmTotalMb: Math.round(16303716 / 1024),
      vmAvailMb: 6144,
    });
  });
});

describe("記憶體暫停判斷不變", () => {
  const r = (memFreeMb: number, vmAvailMb?: number) => ({
    cpus: 8,
    memTotalMb: 16384,
    memFreeMb,
    vmTotalMb: 12288,
    vmAvailMb,
  });

  it("門檻仍是 2 GB 暫停、2.5 GB 恢復", () => {
    expect(MEMORY_FLOOR_MB).toBe(2048);
    expect(MEMORY_RESUME_MB).toBe(2560);
  });

  it("只看 Windows 可用量：VM 可用量很低也不暫停，VM 很充足也照樣暫停", () => {
    expect(memoryHold(r(8192, 100))).toBeNull();
    expect(memoryHold(r(1900, 10000))).toBe(
      "Windows 主機可用記憶體只剩 1.9 GB（低於 2 GB），暫停派新工作，回升到 2.5 GB 以上才恢復；執行中的工作不受影響",
    );
    expect(memoryHold(r(2100, 10000), true)).toBe(
      "Windows 主機可用記憶體 2.1 GB，尚未回升到 2.5 GB，仍暫停派新工作；執行中的工作不受影響",
    );
    expect(memoryHold(r(2560, 100), true)).toBeNull();
  });
});
