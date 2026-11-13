import { expect, it } from "vitest";
import { safeQueueHandler } from "../server/queue-error.js";

it.each([401, 403, 429, 500, 503])(
  "佇列保存 HTTP %s 原因，但不保存供應商錯誤的任何任意欄位",
  async (status) => {
    const marker = "僅存在虛構供應商錯誤中的不透明憑證";
    const error = Object.assign(new Error(marker), {
      name: "HttpError",
      status,
      request: { headers: { authorization: marker }, body: marker },
      response: { data: { message: marker }, headers: { token: marker } },
      cause: new Error(marker),
    });
    const handler = safeQueueHandler(async () => {
      throw error;
    });
    const caught = (await handler([]).catch((e: unknown) => e)) as Error;
    expect(caught).not.toBe(error);
    expect(caught.message).toContain(`HTTP ${status}`);
    const persisted = JSON.stringify(
      caught,
      Object.getOwnPropertyNames(caught),
    );
    expect(persisted).not.toContain(marker);
    expect(Object.getOwnPropertyNames(caught).sort()).toEqual([
      "message",
      "stack",
    ]);
  },
);

it.each([
  {
    value: Object.assign(new Error("虛構網址及token"), { code: "ECONNRESET" }),
    reason: "ECONNRESET",
  },
  {
    value: Object.assign(new Error("虛構網址及token"), { name: "AbortError" }),
    reason: "逾時或中止",
  },
  {
    value: Object.assign(new Error("虛構網址及token"), { statusCode: 429 }),
    reason: "HTTP 429",
  },
  {
    value: {
      message: "虛構網址及token",
      status: "401-secret",
      code: "自訂機密",
    },
    reason: "背景工作執行失敗，",
  },
  { value: "虛構網址及token", reason: "背景工作執行失敗，" },
])("佇列僅允許固定格式診斷 $reason", async ({ value, reason }) => {
  const handler = safeQueueHandler(async () => {
    throw value;
  });
  await expect(handler([])).rejects.toThrow(reason);
  await expect(handler([])).rejects.not.toThrow("token");
});

it("成功工作原樣傳回結果，不改工作參數或執行次數", async () => {
  let count = 0;
  const handler = safeQueueHandler(async (jobs) => {
    count++;
    return { jobs: jobs.length };
  });
  expect(await handler([])).toEqual({ jobs: 0 });
  expect(count).toBe(1);
});

it("SDK 包裝的 HTTP 500 仍保留逾時診斷，任何 cause 內容都不保存", async () => {
  const marker = "假的機密內容";
  const error = Object.assign(new Error(marker), {
    status: 500,
    cause: new DOMException(marker, "TimeoutError"),
  });
  const handler = safeQueueHandler(async () => {
    throw error;
  });
  const caught = (await handler([]).catch((value: unknown) => value)) as Error;
  expect(caught.message).toContain("連線逾時或中止");
  expect(caught.message).not.toContain("HTTP 500");
  expect(
    JSON.stringify(caught, Object.getOwnPropertyNames(caught)),
  ).not.toContain(marker);
});

it("循環 cause 不會卡住佇列或保存錯誤物件", async () => {
  const error = Object.assign(new Error("不可保存內容"), {
    cause: undefined as unknown,
  });
  error.cause = error;
  const handler = safeQueueHandler(async () => {
    throw error;
  });
  await expect(handler([])).rejects.toThrow("背景工作執行失敗，");
});
