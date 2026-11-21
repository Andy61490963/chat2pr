import { describe, expect, it, vi } from "vitest";
import { Database } from "../server/db.js";
import { BatchEnd, Tasks } from "../server/tasks.js";
import type { TaskStatus } from "../shared/types.js";

const selected = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    version: 1,
    status: "awaiting_approval",
  },
  { id: "22222222-2222-4222-8222-222222222222", version: 2, status: "failed" },
  {
    id: "33333333-3333-4333-8333-333333333333",
    version: 1,
    status: "awaiting_approval",
  },
] as const;

function fixture(
  current: { id: string; version: number; status: TaskStatus }[],
) {
  const db = new Database("postgres://demo:fictional@localhost/demo");
  const rows = current.map((task) => ({
    ...task,
    title: "範例任務",
    target_branch: "main",
  }));
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("SELECT * FROM tasks") && sql.endsWith("FOR UPDATE"))
      return { rows };
    if (sql.startsWith("UPDATE tasks")) {
      const task = rows.find(({ id }) => id === params?.[0])!;
      task.status = params?.[1] as TaskStatus;
      return { rows: [task] };
    }
    return { rows: [] };
  });
  vi.spyOn(db, "transaction").mockImplementation((work) =>
    work({ query } as unknown as Parameters<typeof work>[0]),
  );
  return { tasks: new Tasks(db), rows, query };
}

describe("批次結束任務", () => {
  it("三張中一張已被他人結束，結束另外兩張並略過一張", async () => {
    const { tasks, rows, query } = fixture([
      selected[0],
      selected[1],
      { ...selected[2], status: "rejected" },
    ]);
    const request = BatchEnd.parse({
      tasks: selected,
      reason: "已由範例團隊處理",
    });

    expect(await tasks.batchEnd(request, "demo-admin")).toEqual({
      ended: 2,
      skipped: 1,
    });
    expect(rows.map(({ status }) => status)).toEqual([
      "rejected",
      "cancelled",
      "rejected",
    ]);
    const audit = query.mock.calls
      .filter(([sql]) => sql.startsWith("INSERT INTO audit"))
      .map(([, params]) => params);
    expect(audit).toEqual([
      [
        selected[0].id,
        "reject",
        expect.stringContaining("原因：已由範例團隊處理"),
      ],
      [
        selected[1].id,
        "cancel",
        expect.stringContaining("原因：已由範例團隊處理"),
      ],
    ]);
    const notices = query.mock.calls
      .filter(([sql]) => sql.startsWith("INSERT INTO notifications"))
      .map(([, params]) => params);
    expect(notices).toEqual(
      selected
        .slice(0, 2)
        .map(({ id, version }) => [
          id,
          "group_closed",
          `group:closed:${id}:${version}`,
          expect.stringContaining("範例任務"),
          "results",
          null,
        ]),
    );
  });

  it("略過已換版本及已換成另一種可選狀態的任務，並可關閉群組通知", async () => {
    const { tasks, rows, query } = fixture([
      { ...selected[0], version: 2 },
      { ...selected[1], status: "awaiting_approval" },
      selected[2],
    ]);
    const request = BatchEnd.parse({ tasks: selected, notify: false });

    expect(await tasks.batchEnd(request, "demo-admin")).toEqual({
      ended: 1,
      skipped: 2,
    });
    expect(rows.map(({ status }) => status)).toEqual([
      "awaiting_approval",
      "awaiting_approval",
      "rejected",
    ]);
    expect(
      query.mock.calls.some(([sql]) =>
        sql.startsWith("INSERT INTO notifications"),
      ),
    ).toBe(false);
  });
});
