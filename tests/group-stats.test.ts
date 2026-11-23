import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { mostlyRejected } from "../shared/group-stats.js";

let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  await reset();
  await fixture();
  await db.query(
    "INSERT INTO groups(id,name,enabled,trigger_mode) VALUES('group-b','另一個範例群組',true,'auto')",
  );
  app = await buildApp(db);
});
afterEach(() => app.close());
afterAll(() => db.close());

let serial = 0;
const task = async ({
  group = "group-a",
  status = "awaiting_approval",
  mode = "change",
  daysAgo = 1,
  approved = false,
}: {
  group?: string;
  status?: string;
  mode?: string;
  daysAgo?: number;
  approved?: boolean;
} = {}) => {
  const t = await db.one<{ id: string }>(
    `INSERT INTO tasks(group_id,title,summary,status,mode,dedupe_key,created_at)
     VALUES($1,'範例需求','範例摘要',$2,$3,$4,now()-make_interval(days=>$5::int)) RETURNING id`,
    [group, status, mode, `stats-${++serial}`, daysAgo],
  );
  if (approved)
    await db.query(
      "INSERT INTO task_versions(task_id,version,summary,acceptance,approved_by) VALUES($1,1,'範例摘要','[]','小林')",
      [t!.id],
    );
};
const stats = async () =>
  Object.fromEntries(
    (
      await app.inject({ url: "/api/state", headers: await session() })
    )
      .json()
      .groups.map((g: { id: string; change_stats: unknown }) => [
        g.id,
        g.change_stats,
      ]),
  );

describe("群組近 30 天的修改需求數", () => {
  it("只算本群組 30 天內建立的修改需求，核准以有核准者的版本為準", async () => {
    await task({ status: "rejected" });
    await task({ status: "rejected" });
    await task({ status: "merged", approved: true });
    await task({ status: "queued", approved: true });
    await task();
    await task({ status: "rejected", daysAgo: 31 });
    await task({ status: "answered", mode: "query", approved: true });
    await task({ group: "group-b", status: "rejected" });

    expect(await stats()).toEqual({
      "group-a": { created: 5, approved: 2, rejected: 2 },
      "group-b": { created: 1, approved: 0, rejected: 1 },
    });
  });

  it("沒有修改需求的群組數字都是 0", async () => {
    expect((await stats())["group-a"]).toEqual({
      created: 0,
      approved: 0,
      rejected: 0,
    });
  });

  it("拒絕至少 5 筆且佔一半以上才建議改成指令觸發", () => {
    expect(mostlyRejected({ created: 24, approved: 0, rejected: 24 })).toBe(
      true,
    );
    expect(mostlyRejected({ created: 10, approved: 3, rejected: 5 })).toBe(
      true,
    );
    expect(mostlyRejected({ created: 11, approved: 3, rejected: 5 })).toBe(
      false,
    );
    expect(mostlyRejected({ created: 4, approved: 0, rejected: 4 })).toBe(
      false,
    );
  });
});
