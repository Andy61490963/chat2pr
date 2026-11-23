import { describe, expect, it } from "vitest";
import {
  bringHostBack,
  hostStartRoute,
  hostStateAdvice,
  startupTaskCheck,
  type HostStartIo,
} from "../scripts/lib/host-start.mjs";

describe("開機排程工作的狀態", () => {
  it("存在且未停用才算有效", () => {
    expect(startupTaskCheck("Ready")).toMatchObject({ usable: true });
    expect(startupTaskCheck("Running")).toMatchObject({ usable: true });
  });

  it("已停用或不存在時提醒如何修復", () => {
    for (const state of ["Disabled", undefined]) {
      const check = startupTaskCheck(state);
      expect(check.usable).toBe(false);
      expect(check.detail).toContain("重開機後");
      expect(check.detail).toContain("npm run install:startup");
    }
    expect(startupTaskCheck("Disabled").detail).toContain("已停用");
    expect(startupTaskCheck(undefined).detail).toContain("沒有排程工作");
  });
});

describe("部署後帶回主機程序的路徑", () => {
  it("排程工作啟動且監督程序出現：走排程工作", () => {
    expect(
      hostStartRoute({ taskState: "Ready", started: true, appeared: true }),
    ).toEqual({ route: "task" });
  });

  it("排程工作已停用：直接啟動", () => {
    expect(hostStartRoute({ taskState: "Disabled" })).toMatchObject({
      route: "direct",
      reason: expect.stringContaining("已停用"),
    });
  });

  it("排程工作不存在：直接啟動", () => {
    expect(hostStartRoute({ taskState: undefined })).toMatchObject({
      route: "direct",
      reason: expect.stringContaining("沒有排程工作"),
    });
  });

  it("啟動指令失敗：直接啟動", () => {
    expect(
      hostStartRoute({ taskState: "Ready", started: false }),
    ).toMatchObject({
      route: "direct",
      reason: expect.stringContaining("指令失敗"),
    });
  });

  it("啟動指令成功但監督程序沒出現：直接啟動", () => {
    expect(
      hostStartRoute({ taskState: "Ready", started: true, appeared: false }),
    ).toMatchObject({
      route: "direct",
      reason: expect.stringContaining("沒有出現監督程序"),
    });
  });
});

/** 假的作業系統：記錄呼叫，監督程序在指定的啟動方式後才「出現」。 */
function fakeHost({
  taskState,
  taskStarts = true,
  appearsAfter,
}: {
  taskState: string | undefined;
  taskStarts?: boolean;
  appearsAfter: "task" | "direct" | "never";
}) {
  const calls: string[] = [];
  let running = false;
  const io: HostStartIo = {
    taskState: () => taskState,
    startTask: () => {
      calls.push("startTask");
      if (taskStarts && appearsAfter === "task") running = true;
      return taskStarts;
    },
    startDirect: () => {
      calls.push("startDirect");
      if (appearsAfter === "direct") running = true;
    },
    supervisorRunning: () => running,
    wait: async () => {},
  };
  return { io, calls };
}

describe("帶回主機程序（假的作業系統）", () => {
  it("正常：只啟動排程工作", async () => {
    const host = fakeHost({ taskState: "Ready", appearsAfter: "task" });
    expect(await bringHostBack(host.io)).toEqual({
      route: "task",
      running: true,
    });
    expect(host.calls).toEqual(["startTask"]);
  });

  it("已停用：不碰排程工作，直接啟動監督程序", async () => {
    const host = fakeHost({ taskState: "Disabled", appearsAfter: "direct" });
    expect(await bringHostBack(host.io)).toMatchObject({
      route: "direct",
      running: true,
    });
    expect(host.calls).toEqual(["startDirect"]);
  });

  it("不存在：直接啟動監督程序", async () => {
    const host = fakeHost({ taskState: undefined, appearsAfter: "direct" });
    expect(await bringHostBack(host.io)).toMatchObject({
      route: "direct",
      running: true,
    });
    expect(host.calls).toEqual(["startDirect"]);
  });

  it("啟動指令成功但程序沒出現：改用直接啟動", async () => {
    const host = fakeHost({ taskState: "Ready", appearsAfter: "direct" });
    expect(await bringHostBack(host.io)).toMatchObject({
      route: "direct",
      reason: expect.stringContaining("沒有出現監督程序"),
      running: true,
    });
    expect(host.calls).toEqual(["startTask", "startDirect"]);
  });

  it("兩條路都帶不回來時回報沒有執行", async () => {
    const host = fakeHost({
      taskState: "Ready",
      taskStarts: false,
      appearsAfter: "never",
    });
    expect(await bringHostBack(host.io)).toMatchObject({
      route: "direct",
      running: false,
    });
    expect(host.calls).toEqual(["startTask", "startDirect"]);
  });
});

describe("部署失敗時的狀態說明", () => {
  it("監督程序停了：說明影響與恢復指令", () => {
    const lines = hostStateAdvice({
      supervisor: false,
      runner: false,
      app: true,
      taskState: "Disabled",
    }).join("\n");
    expect(lines).toContain("監督程序沒有執行");
    expect(lines).toContain("npm run install:startup");
    expect(lines).toContain("Start-ScheduledTask -TaskName 'LINE-AgentFlow'");
  });

  it("排程工作有效時直接啟動它即可", () => {
    const lines = hostStateAdvice({
      supervisor: false,
      runner: false,
      app: true,
      taskState: "Ready",
    }).join("\n");
    expect(lines).toContain("Start-ScheduledTask -TaskName 'LINE-AgentFlow'");
    expect(lines).not.toContain("install:startup");
  });

  it("監督程序在跑、只有執行器或 app 沒回應", () => {
    const lines = hostStateAdvice({
      supervisor: true,
      runner: false,
      app: false,
      taskState: "Ready",
    }).join("\n");
    expect(lines).not.toContain("監督程序沒有執行");
    expect(lines).toContain("執行器沒有回應");
    expect(lines).toContain("docker compose logs --tail 100 app");
  });

  it("全部正常時明說沒有東西停著", () => {
    expect(
      hostStateAdvice({
        supervisor: true,
        runner: true,
        app: true,
        taskState: "Ready",
      }).join("\n"),
    ).toContain("都在執行");
  });
});
