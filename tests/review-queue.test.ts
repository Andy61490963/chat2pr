import { expect, test } from "vitest";
import {
  nextReviewItem,
  reviewItems,
  sortReviewItems,
} from "../shared/review-queue.js";

const oldest = "2026-11-21T05:00:00Z";
const middle = "2026-11-21T06:00:00Z";
const newest = "2026-11-21T07:00:00Z";
const groups = [
  { id: "demo-group", name: "範例群組", platform: "discord" },
] as const;
const base = {
  id: "change",
  title: "修改範例表單",
  summary: "新增一個範例欄位",
  group_id: "demo-group",
  status: "awaiting_approval",
  mode: "change",
  project_id: "demo-project",
  suggestions: [] as [],
  missing: [] as [],
  last_error: null,
  created_at: oldest,
  updated_at: newest,
} as const;
const list = {
  id: "first",
  groupId: "demo-group",
  version: 1,
  items: [{ id: "choice", title: "整理範例欄位", summary: "整理待辦。", riskReasons: [] }],
};

test("每筆佇列只輸出一個下一步，補問比指定專案優先", () => {
  const items = reviewItems(
    [
      base,
      { ...base, id: "query", mode: "query" },
      { ...base, id: "assign", project_id: null },
      {
        ...base,
        id: "answer",
        project_id: null,
        question: { text: "要整理哪一欄？", choices: [] },
      },
      { ...base, id: "amend", missing: ["要補上欄位名稱"] },
      {
        ...base,
        id: "options",
        suggestions: [
          {
            label: "僅修改範例欄位",
            summary: "縮小變更範圍。",
            acceptance: ["其他欄位維持原樣"],
          },
        ],
      },
      { ...base, id: "retry", status: "failed" },
    ],
    [list],
    groups,
    true,
  );
  expect(items.map(({ status }) => status)).toEqual([
    "等你核准修改",
    "等你決定：確認需求",
    "等你決定：選專案",
    "等你回答：補充需求",
    "等你補充：修改需求",
    "等你決定：選方案",
    "等你處理：重試任務",
    "等你決定：挑選任務",
  ]);
  expect(items.at(-1)).toEqual({
    kind: "pickList",
    id: "list-first",
    title: "待挑選清單：整理範例欄位",
    group: "範例群組",
    platform: "discord",
    waitingSince: null,
    status: "等你決定：挑選任務",
  });
});

test("需要先修設定時只引導管理者前往設定，成員先查看詳情", () => {
  const failed = {
    ...base,
    status: "failed" as const,
    last_error: "設定問題：找不到測試指令。\n建議：請到專案頁補上測試指令。",
  };
  expect(reviewItems([failed], [], groups, true)[0].status).toBe(
    "等你處理：前往專案設定",
  );
  expect(reviewItems([failed], [], groups, false)[0].status).toBe(
    "等你處理：查看詳情",
  );
});

test("待審用建立時間，失敗用更新時間，未提供時間的清單依既有順序排列", () => {
  const items = reviewItems(
    [
      {
        ...base,
        id: "failed",
        status: "failed",
        created_at: oldest,
        updated_at: middle,
      },
      { ...base, id: "newest", created_at: newest },
      base,
    ],
    [list, { ...list, id: "second" }],
    groups,
    true,
  );
  expect(items.map((item) => item.waitingSince)).toEqual([
    middle,
    newest,
    oldest,
    null,
    null,
  ]);
  expect(sortReviewItems(items, "oldest").map(({ id }) => id)).toEqual([
    "change",
    "failed",
    "newest",
    "list-first",
    "list-second",
  ]);
  expect(sortReviewItems(items, "newest").map(({ id }) => id)).toEqual([
    "newest",
    "failed",
    "change",
    "list-second",
    "list-first",
  ]);
  expect(items[0].id).toBe("failed");
});

test("清單比任務等得久時，在等最久排序排第一", () => {
  const items = reviewItems(
    [{ ...base, created_at: middle }],
    [{ ...list, createdAt: oldest }],
    groups,
    true,
  );
  expect(sortReviewItems(items, "oldest").map(({ id }) => id)).toEqual([
    "list-first",
    "change",
  ]);
});

test("最新排序將較晚建立的任務排在等得更久的清單之前", () => {
  const items = reviewItems(
    [
      { ...base, id: "newer-task", created_at: newest },
      { ...base, id: "older-task" },
    ],
    [{ ...list, createdAt: middle }],
    groups,
    true,
  );
  expect(sortReviewItems(items, "newest").map(({ id }) => id)).toEqual([
    "newer-task",
    "list-first",
    "older-task",
  ]);
});

test("缺少建立時間的清單在兩種排序都排在有時間的清單和任務之後", () => {
  const items = reviewItems(
    [{ ...base, created_at: middle }],
    [list, { ...list, id: "dated", createdAt: oldest }],
    groups,
    true,
  );
  expect(sortReviewItems(items, "oldest").map(({ id }) => id)).toEqual([
    "list-dated",
    "change",
    "list-first",
  ]);
  expect(sortReviewItems(items, "newest").map(({ id }) => id)).toEqual([
    "change",
    "list-dated",
    "list-first",
  ]);
});

test("處理完成後選下一筆，已在最後則選前一筆，沒有相鄰案件時回傳空值", () => {
  const items = reviewItems(
    [base, { ...base, id: "second" }],
    [list],
    groups,
    true,
  );
  expect(nextReviewItem(items, "change")?.id).toBe("second");
  expect(nextReviewItem(items, "second")?.id).toBe("list-first");
  expect(nextReviewItem(items, "list-first")?.id).toBe("second");
  expect(nextReviewItem(items.slice(0, 1), "change")).toBeNull();
  expect(nextReviewItem(items, "unknown")).toBeNull();
});
