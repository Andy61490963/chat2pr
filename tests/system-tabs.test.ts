import { describe, expect, it } from "vitest";
import {
  containerCondition,
  diskAttentionCount,
  readSystemTab,
  serviceKey,
} from "../shared/system-tabs.js";
import { workerImageStatus } from "../shared/status-glossary.js";

describe("系統分頁網址", () => {
  it("辨識四個分頁，缺少或不認得的參數回到執行", () => {
    for (const tab of ["execution", "disk", "network", "architecture"])
      expect(readSystemTab(tab)).toBe(tab);
    for (const tab of [null, "", "unknown", "toString", "__proto__"])
      expect(readSystemTab(tab)).toBe("execution");
  });
});

describe("容器與磁碟待處理數量", () => {
  const healthy = {
    probeFailed: false,
    services: [
      containerCondition({ state: "running", status: "Up (healthy)" }),
    ],
    images: [workerImageStatus(true, true), workerImageStatus(false, false)],
    diskLevel: "ok",
    diskPaused: false,
  } as const;

  it("正常服務、符合版本的映像、無專案使用的舊映像及充足空間都不計入", () => {
    expect(diskAttentionCount(healthy)).toBe(0);
  });

  it("停止與健康檢查未通過的服務各計一項，加上使用中的舊映像與空間不足", () => {
    expect(
      diskAttentionCount({
        ...healthy,
        services: [
          ...healthy.services,
          containerCondition({ state: "running", status: "Up (unhealthy)" }),
          containerCondition({ state: "exited", status: "Exited (1)" }),
        ],
        images: [...healthy.images, workerImageStatus(false, true)],
        diskLevel: "low",
      }),
    ).toBe(4);
  });

  it("探測失敗以一項代表容器狀態，嚴重不足且暫停派工仍只計一項磁碟問題", () => {
    expect(
      diskAttentionCount({
        ...healthy,
        probeFailed: true,
        services: ["unhealthy", "stopped"],
        images: ["outdated"],
        diskLevel: "critical",
        diskPaused: true,
      }),
    ).toBe(2);
  });

  it("磁碟尚未盤點時仍計入已知的磁碟派工暫停", () => {
    expect(
      diskAttentionCount({ ...healthy, diskLevel: null, diskPaused: true }),
    ).toBe(1);
    expect(diskAttentionCount({ ...healthy, diskLevel: "unknown" })).toBe(0);
  });
});

describe("服務名稱與平常停止的服務", () => {
  it("認得帶前綴或編號的容器名稱", () => {
    expect(serviceKey("33273886db7e_line-agentflow-egress")).toBe("egress");
    expect(serviceKey("line-agentflow-egress-ai-1")).toBe("egress-ai");
    expect(serviceKey("line-agentflow-db-test-1")).toBe("db-test");
    expect(serviceKey("示範容器")).toBe("示範容器");
  });

  it("測試資料庫停止是常態，不計入待處理；其他服務停止仍計入", () => {
    const idle = containerCondition({
      name: "line-agentflow-db-test-1",
      state: "exited",
      status: "Exited (0) 20 minutes ago",
    });
    expect(idle).toBe("idle");
    const stopped = containerCondition({
      name: "line-agentflow-db-1",
      state: "exited",
      status: "Exited (1)",
    });
    expect(stopped).toBe("stopped");
    expect(
      diskAttentionCount({
        probeFailed: false,
        services: [idle, stopped],
        images: [],
        diskLevel: "ok",
        diskPaused: false,
      }),
    ).toBe(1);
  });
});
