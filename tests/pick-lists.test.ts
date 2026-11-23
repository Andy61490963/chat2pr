import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { Budget } from "../server/budget.js";
import { GitHub } from "../server/github.js";
import { Line } from "../server/line.js";
import { Triage } from "../server/triage.js";
import type {
  Group,
  Message,
  Project,
  Task,
  TriageDecision,
} from "../shared/types.js";
import type { PickList } from "../shared/pick-list.js";
import { db, fixture, reset, session } from "./helpers.js";

beforeEach(async () => {
  await reset();
  await fixture();
});
afterAll(() => db.close());

const titles = [
  "調整首頁色彩",
  "縮短說明文字",
  "對齊表格欄位",
  "更新匯出檔名",
  "增加空白提示",
  "調整列印版面",
];
const root = "example-meeting";
const original = (title: string): TriageDecision => ({
  kind: "request",
  projectId: null,
  title,
  summary: `${title}。`,
  acceptance: [`可以驗證「${title}」。`],
  sourceIds: [root],
  risks: [],
  missing: [],
  relatedTaskId: null,
  suggestions: [],
});

async function apply(
  sourceId: string,
  batchId: string,
  text: string,
  decisions: TriageDecision[],
) {
  await db.query(
    "INSERT INTO messages(id,group_id,type,text) VALUES($1,'group-a','text',$2)",
    [sourceId, text],
  );
  const group = await db.one<Group>("SELECT * FROM groups WHERE id='group-a'");
  const project = await db.one<Project>("SELECT * FROM projects");
  const messages = await db.query<Message>(
    "SELECT * FROM messages WHERE id=$1",
    [sourceId],
  );
  await new Triage(
    db,
    { classify: async () => [] },
    new GitHub(),
    new Line(db),
    new Budget(db),
  ).apply(group, [project], messages, decisions, batchId);
}

async function meeting(count = 6) {
  const items = titles.slice(0, count);
  await apply(
    root,
    "00000000-0000-4000-8000-000000000136",
    `@All 本次會議提到的改動：\n${items.map((title, i) => `${i + 1}. ${title}`).join("\n")}`,
    items.map(original),
  );
}

async function dashboard(
  check: (
    state: () => Promise<{ pickLists: PickList[]; tasks: Task[] }>,
    resolve: (list: PickList, itemIds: string[]) => Promise<number>,
  ) => Promise<void>,
) {
  const app = await buildApp(db);
  try {
    const headers = await session();
    await check(
      async () => (await app.inject({ url: "/api/state", headers })).json(),
      async (list, itemIds) =>
        (
          await app.inject({
            method: "POST",
            url: `/api/pick-lists/${list.id}/resolve`,
            headers,
            payload: { version: list.version, itemIds },
          })
        ).statusCode,
    );
  } finally {
    await app.close();
  }
}

describe("待挑選清單和任務建立", () => {
  it("看板狀態以 ISO 字串回傳待挑選清單的建立時間", async () => {
    await meeting();
    await db.query("UPDATE pick_lists SET created_at=$1 WHERE root_id=$2", [
      "2026-11-21T13:45:00.123+08:00",
      root,
    ]);
    await dashboard(async (state) => {
      const [list] = (await state()).pickLists;
      expect(list.createdAt).toBe("2026-11-21T05:45:00.123Z");
    });
  });

  it("會議紀錄只有修改登入功能的項目顯示敏感提醒", async () => {
    const items = [
      "首頁看板顯示今日待辦數量",
      "報表匯出新增建立日期欄位",
      "登入頁加上忘記密碼連結",
    ];
    const risk = "涉及敏感功能，必須人工審核";
    await apply(
      root,
      "00000000-0000-4000-8000-000000000215",
      `本次會議提到的改動：\n${items.map((title, i) => `${i + 1}. ${title}`).join("\n")}`,
      items.map((title, i) =>
        i === 2
          ? {
              ...original(title),
              summary: "加上找回帳號存取的連結。",
              acceptance: ["登入頁顯示忘記密碼連結。"],
            }
          : original(title),
      ),
    );
    await dashboard(async (state, resolve) => {
      const [list] = (await state()).pickLists;
      expect(
        list.items.map(({ title, riskReasons }) => [title, riskReasons]),
      ).toEqual([
        [items[0], []],
        [items[1], []],
        [items[2], [risk]],
      ]);
      expect(
        await resolve(
          list,
          list.items.map(({ id }) => id),
        ),
      ).toBe(200);
      expect((await state()).tasks).toEqual(
        expect.arrayContaining(
          items.map((title, i) =>
            expect.objectContaining({
              title,
              risk_reasons: i === 2 ? [risk] : [],
            }),
          ),
        ),
      );
    });
  });
  it("六項只建立一張清單，選兩項後只建立兩張待確認任務", async () => {
    await meeting();
    await dashboard(async (state, resolve) => {
      const before = await state();
      expect(before.tasks).toEqual([]);
      expect(before.pickLists).toHaveLength(1);
      const [list] = before.pickLists;
      expect(list.items.map(({ title }) => title)).toEqual(titles);
      expect(
        await db.query(
          "SELECT text FROM notifications WHERE group_id='group-a'",
        ),
      ).toEqual([{ text: "收到 6 項待辦，管理者挑選後才會開始處理。" }]);

      const selected = [list.items[0], list.items[4]];
      expect(
        await resolve(
          list,
          selected.map(({ id }) => id),
        ),
      ).toBe(200);
      const after = await state();
      expect(after.pickLists).toEqual([]);
      expect(after.tasks).toHaveLength(2);
      expect(after.tasks).toEqual(
        expect.arrayContaining(
          selected.map(({ title }) =>
            expect.objectContaining({
              title,
              status: "awaiting_approval",
              source_ids: [root],
              approved_version: null,
            }),
          ),
        ),
      );
      expect(
        await resolve(
          list,
          selected.map(({ id }) => id),
        ),
      ).toBe(409);
      expect(
        await db.query(
          "SELECT text FROM notifications WHERE group_id='group-a'",
        ),
      ).toHaveLength(1);
    });
  });

  it("全部不做會結束清單且不建立任務，關閉群組回覆時不排通知", async () => {
    await db.query("UPDATE groups SET reply_mode='off' WHERE id='group-a'");
    await meeting();
    await dashboard(async (state, resolve) => {
      const [list] = (await state()).pickLists;
      expect(await resolve(list, [])).toBe(200);
      expect(await state()).toMatchObject({ pickLists: [], tasks: [] });
      expect(
        await db.query(
          "SELECT text FROM notifications WHERE group_id='group-a'",
        ),
      ).toEqual([]);
    });
  });

  it.each([1, 2])("只有 %i 項時照舊逐項建立", async (count) => {
    await meeting(count);
    await dashboard(async (state) => {
      const result = await state();
      expect(result.pickLists).toEqual([]);
      expect(result.tasks).toHaveLength(count);
    });
  });

  it("補充歸到原項目，選取後任務仍可查到原訊息和補充", async () => {
    await meeting();
    await dashboard(async (state, resolve) => {
      const [before] = (await state()).pickLists;
      const id = "example-followup";
      const item = before.items[0];
      await apply(
        id,
        "00000000-0000-4000-8000-000000000137",
        "首頁色彩請用藍色。",
        [
          {
            ...original(titles[0]),
            summary: "調整首頁色彩為藍色。",
            sourceIds: [id],
            relatedListItemId: item.id,
          },
        ],
      );
      const [after] = (await state()).pickLists;
      expect(after.items[0]).toMatchObject({
        id: item.id,
        summary: "調整首頁色彩為藍色。",
      });
      expect(await resolve(before, [item.id])).toBe(409);
      expect(await resolve(after, [item.id])).toBe(200);
      expect((await state()).tasks).toEqual([
        expect.objectContaining({ source_ids: [root, id] }),
      ]);
    });
  });

  it("原訊息撤回後結束清單，舊畫面無法建立任務", async () => {
    await meeting();
    await dashboard(async (state, resolve) => {
      const [list] = (await state()).pickLists;
      await new Line(db).ingest({
        events: [
          {
            webhookEventId: "example-withdrawal",
            type: "unsend",
            source: { type: "group", groupId: "group-a" },
            unsend: { messageId: root },
          },
        ],
      });
      expect(await resolve(list, [list.items[0].id])).toBe(409);
      expect(await state()).toMatchObject({ pickLists: [], tasks: [] });
    });
  });
});
