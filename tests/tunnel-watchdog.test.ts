import { describe, expect, it } from "vitest";
import {
  RETRY_MS,
  STALE_MS,
  findTunnelTask,
  statusAge,
  tunnelWatchdog,
} from "../scripts/lib/tunnel-watchdog.mjs";

const root = "C:\\fictional\\chat2pr-prod";
const listing = [
  "\\|Fictional-Backup|C:\\Windows\\backup.exe /daily",
  '\\|chat2pr-host|C:\\Program Files\\nodejs\\node.exe "C:\\fictional\\chat2pr-prod\\scripts\\start-windows.mjs"',
  '\\Fictional\\|chat2pr-edge|C:\\Program Files\\nodejs\\node.exe "C:/fictional/chat2pr-prod/.local/cloudflare-supervisor.mjs"',
  '\\|other-tunnel|node.exe "C:/fictional/other-app/.local/cloudflare-supervisor.mjs"',
].join("\r\n");

describe("外部通道看門狗：判斷", () => {
  it("沒有狀態檔就不處理；時間壞掉的狀態檔視為過期", () => {
    const now = Date.parse("2026-11-16T02:00:00Z");
    expect(statusAge(undefined, now)).toBeNull();
    expect(
      statusAge(JSON.stringify({ checked_at: "2026-11-16T01:59:30Z" }), now),
    ).toBe(30000);
    expect(statusAge("不是 JSON", now)).toBe(Infinity);
    expect(statusAge(JSON.stringify({ ok: true }), now)).toBe(Infinity);
  });

  it("只認動作指向本目錄 .local 通道腳本的排程工作，不分斜線方向與大小寫", () => {
    expect(findTunnelTask(listing, root)).toEqual({
      path: "\\Fictional\\",
      name: "chat2pr-edge",
    });
    expect(findTunnelTask(listing, "C:/FICTIONAL/chat2pr-prod/")).toEqual({
      path: "\\Fictional\\",
      name: "chat2pr-edge",
    });
    // 主機監督程式本身、其他目錄的通道都不算。
    expect(findTunnelTask(listing, "C:\\fictional\\unknown")).toBeNull();
  });
});

describe("外部通道看門狗：重新啟動", () => {
  const setup = (opts: { status?: string; startFails?: boolean } = {}) => {
    let clock = Date.parse("2026-11-16T02:00:00Z");
    const notes: string[] = [];
    const commands: string[] = [];
    const check = tunnelWatchdog({
      root,
      note: (text) => notes.push(text),
      platform: "win32",
      now: () => clock,
      read: () => {
        if (opts.status === undefined) throw new Error("ENOENT");
        return opts.status;
      },
      run: (_file, args) => {
        const command = args.at(-1) ?? "";
        commands.push(command);
        if (command.includes("Get-ScheduledTask"))
          return { status: 0, stdout: listing, stderr: "" };
        return opts.startFails
          ? { status: 1, stdout: "", stderr: "存取被拒" }
          : { status: 0, stdout: "", stderr: "" };
      },
    });
    return {
      check,
      notes,
      commands,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  };
  const stale = JSON.stringify({ checked_at: "2026-11-16T01:50:00Z" });

  it("狀態檔還新、沒有狀態檔或不是 Windows 時不做任何事", () => {
    const fresh = setup({
      status: JSON.stringify({ checked_at: "2026-11-16T01:59:00Z" }),
    });
    expect(fresh.check()).toBeNull();
    expect(setup().check()).toBeNull();
    expect(fresh.commands).toEqual([]);
    const linux = tunnelWatchdog({
      root,
      note: () => {},
      platform: "linux",
      read: () => stale,
      run: () => {
        throw new Error("不該執行");
      },
    });
    expect(linux()).toBeNull();
  });

  it("過期時找出排程工作並重新啟動；3 分鐘內不重複，之後沿用找到的工作", () => {
    const s = setup({ status: stale });
    expect(s.check()).toBe("restarted");
    expect(s.commands).toHaveLength(2);
    expect(s.commands[1]).toContain(
      "Start-ScheduledTask -TaskPath '\\Fictional\\' -TaskName 'chat2pr-edge'",
    );
    expect(s.notes[0]).toContain("重新啟動排程工作「chat2pr-edge」");
    s.advance(RETRY_MS - 1000);
    expect(s.check()).toBeNull();
    s.advance(2000);
    expect(s.check()).toBe("restarted");
    expect(
      s.commands.filter((c) => c.includes("Get-ScheduledTask")),
    ).toHaveLength(1);
    expect(STALE_MS).toBe(180000);
  });

  it("啟動失敗時記下原因，下次重新尋找工作", () => {
    const s = setup({ status: stale, startFails: true });
    expect(s.check()).toBe("failed");
    expect(s.notes[0]).toContain("存取被拒");
    s.advance(RETRY_MS);
    s.check();
    expect(
      s.commands.filter((c) => c.includes("Get-ScheduledTask")),
    ).toHaveLength(2);
  });

  it("找不到排程工作時只記錄，請人手動檢查", () => {
    const check = tunnelWatchdog({
      root: "C:\\fictional\\unknown",
      note: (text) => notes.push(text),
      platform: "win32",
      read: () => stale,
      now: () => Date.parse("2026-11-16T02:00:00Z"),
      run: () => ({ status: 0, stdout: listing, stderr: "" }),
    });
    const notes: string[] = [];
    expect(check()).toBe("not-found");
    expect(notes[0]).toContain("找不到啟動它的排程工作");
  });
});
