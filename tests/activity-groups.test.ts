import { describe, expect, it } from "vitest";
import {
  activityDetail,
  activityStatus,
  groupActivity,
  type ActivityEvent,
} from "../shared/activity-groups.js";

const title = "重新確認示範機台是否連得上";

function event(id: number, fields: Partial<ActivityEvent>): ActivityEvent {
  return {
    id,
    task_id: null,
    kind: "settings",
    detail: "小林更新示範專案的設定",
    created_at: `2026-01-10T08:0${id}:00Z`,
    ...fields,
  };
}

describe("最近動態分組", () => {
  it("同一天的不同任務事件合併，取最新狀態，步驟依時間排列且省略重複標題", () => {
    const task = {
      task_id: "demo-task",
      task_title: title,
      task_mode: "query",
    } as const;
    const scheduled = event(1, {
      ...task,
      kind: "triage",
      detail: "需求明確且通過風險規則，已自動排程",
    });
    const started = event(2, {
      ...task,
      kind: "attempt",
      detail: "開始程式修改",
    });
    const answered = event(3, {
      ...task,
      kind: "answered",
      detail: `查詢已回覆：${title}`,
    });
    const [group] = groupActivity([started, answered, scheduled]);

    expect(groupActivity([started, answered, scheduled])).toHaveLength(1);
    expect(group.latest).toBe(answered);
    expect(activityStatus(group.latest)).toBe("已回覆");
    expect(group.steps.map(({ event }) => activityDetail(event))).toEqual([
      "需求明確且通過風險規則，已自動排程",
      "開始調查",
      "查詢已回覆",
    ]);
    expect(answered.detail).toBe(`查詢已回覆：${title}`);
  });

  it("相同操作跨過其他事件仍會合併，不同操作者、對象或操作各自保留", () => {
    const records = [
      event(1, {}),
      event(2, { detail: "小周更新示範專案的設定" }),
      event(3, { detail: "小林更新範例專案的設定" }),
      event(4, { detail: "小林停用示範專案" }),
      event(5, {}),
    ];
    expect(
      groupActivity(records).map(({ latest, steps }) => [
        latest.id,
        steps[0].times,
      ]),
    ).toEqual([
      [5, 2],
      [4, 1],
      [3, 1],
      [2, 1],
    ]);
  });

  it("同任務和相同操作都依台北午夜分開，同名任務依識別碼分開", () => {
    const before = "2026-01-10T15:59:00Z";
    const after = "2026-01-10T16:00:00Z";
    const records = [
      event(1, { created_at: before }),
      event(2, { created_at: after }),
      event(3, { task_id: "demo-task", task_title: title, created_at: before }),
      event(4, { task_id: "demo-task", task_title: title, created_at: after }),
      event(5, {
        task_id: "other-demo-task",
        task_title: title,
        created_at: after,
      }),
    ];
    expect(
      groupActivity(records).map(({ day, latest }) => [day, latest.id]),
    ).toEqual([
      ["2026-01-11", 2],
      ["2026-01-11", 4],
      ["2026-01-11", 5],
      ["2026-01-10", 1],
      ["2026-01-10", 3],
    ]);
  });

  it("系統步驟可一併查看，任務摘要仍顯示最新進度", () => {
    const task_id = "demo-task";
    const answer = event(1, {
      task_id,
      kind: "answered",
      detail: "查詢已回覆：示範機台",
    });
    const technical = event(2, {
      task_id,
      kind: "query_note",
      detail: "查詢提醒（不阻擋）：示範機台未登記",
    });
    const [group] = groupActivity([technical, answer], true);
    expect(groupActivity([technical, answer])[0].steps).toEqual([
      { event: answer, times: 1 },
    ]);
    expect(group.latest).toBe(answer);
    expect(group.steps.map(({ event }) => event)).toEqual([answer, technical]);
  });

  it("任務失敗的步驟保留原因與處理方式", () => {
    const failed = event(1, {
      task_id: "demo-task",
      kind: "error",
      detail:
        "設定問題（測試階段）：缺少示範機台的連線設定。\n建議：在示範專案補上機台連線。",
    });
    expect(activityStatus(failed)).toBe("需要處理");
    expect(activityDetail(failed)).toBe(
      "這次執行未完成。缺少示範機台的連線設定。建議在示範專案補上機台連線。",
    );
  });

  it("例行 Docker 清理一律歸入系統紀錄；自動清理規則只有確實刪除或釋放空間時才在主要動態", () => {
    const regular =
      "Docker 定期清理：刪除 0 個舊映像標籤；0 個懸空映像；建置快取 0.0 GB；映像共釋放 0.0 GB";
    const auto = "Docker 自動清理（建置快取）：";
    const records = [
      event(1, { kind: "docker_cleanup", detail: regular }),
      event(2, {
        kind: "docker_cleanup",
        detail: regular.replace("刪除 0", "刪除 1"),
      }),
      event(3, {
        kind: "docker_cleanup",
        detail: regular.replace("快取 0.0", "快取 0.1"),
      }),
      event(4, {
        kind: "docker_disk_auto",
        detail: auto + "沒有符合規則的項目",
      }),
      event(5, {
        kind: "docker_disk_auto",
        detail: auto + "刪除 0 項；約釋放 0.0 GB",
      }),
      event(6, {
        kind: "docker_disk_auto",
        detail: auto + "刪除 1 項；約釋放 0.0 GB",
      }),
      event(7, {
        kind: "docker_cleanup",
        detail: regular + "；1 個舊標籤仍有容器在用，保留",
      }),
      event(8, {
        kind: "docker_cleanup",
        detail: regular.replace("0 個懸空", "1 個懸空"),
      }),
      event(9, {
        kind: "docker_disk_auto",
        detail: auto + "刪除 0 項；約釋放 0.1 GB",
      }),
    ];
    expect(groupActivity(records).map(({ latest }) => latest.id)).toEqual([
      9, 6,
    ]);
    expect(groupActivity(records, true)).toHaveLength(records.length);
  });
});
