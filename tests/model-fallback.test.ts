import { expect, it } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import { ObservationBuffer } from "../server/observation.js";
import {
  eventLabels,
  runEventKind,
  type RunEvent,
} from "../shared/observation.js";
// @ts-expect-error 工作容器以原生 ESM 執行。
import { observeTurn } from "../worker/observe.mjs";

const fallback =
  "Model metadata for `demo-model.2` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";

function observe(events: ThreadEvent[]) {
  const buffer = new ObservationBuffer();
  const thread = { runStreamed: async () => ({ events }) };
  const result = observeTurn(thread, "示範需求", {}, (event: RunEvent) =>
    buffer.add("demo", "code", event),
  );
  return { result, recorded: () => buffer.read("demo") };
}

const label = (event: RunEvent) => eventLabels[runEventKind(event)];

it("備援後回答完成，紀錄保留原始錯誤事件並顯示為提示", async () => {
  const { result, recorded } = observe([
    {
      type: "item.completed",
      item: { id: "notice", type: "error", message: fallback },
    },
    {
      type: "item.completed",
      item: { id: "reply", type: "agent_message", text: "查詢完成" },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 3,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    },
  ]);
  await expect(result).resolves.toMatchObject({ final: "查詢完成" });
  expect(recorded()[0]).toMatchObject({ kind: "error", detail: fallback });
  expect(recorded().map(label)).toEqual(["提示", "Codex 回覆", "Token 用量"]);
});

it("備援後推論失敗，提示與已遮蔽的致命錯誤分列", async () => {
  const { result, recorded } = observe([
    { type: "error", message: fallback },
    {
      type: "turn.failed",
      error: { message: "推論失敗 access_token=DemoSecret278" },
    },
  ]);
  await expect(result).rejects.toThrow("推論失敗");
  expect(recorded().map(label)).toEqual(["提示", "錯誤"]);
  expect(recorded()[1].detail).toBe("推論失敗 access_token=[已遮蔽]");
});

it.each([
  { position: "前", unknown: "推論失敗：" + fallback },
  { position: "後", unknown: fallback + "\n載入備援設定失敗" },
])(
  "未知錯誤在備援訊息$position另有原因，仍列為錯誤且串流未完成",
  async ({ unknown }) => {
    const { result, recorded } = observe([{ type: "error", message: unknown }]);
    await expect(result).rejects.toThrow("事件串流未完成");
    expect(recorded()[0].detail).toBe(unknown);
    expect(recorded().map(label)).toEqual(["錯誤"]);
  },
);

it.each([
  ["demo/model", "notice"],
  ["demo-model:7b", "notice"],
  ["demo model", "error"],
  ["demo\nmodel", "error"],
])("備援模型名稱 %j 依完整格式分類", (model, expected) => {
  expect(runEventKind({ phase: "code", kind: "error", detail: fallback.replace("demo-model.2", model) })).toBe(expected);
});

it("回覆引述備援訊息仍是回覆，已清除內容的錯誤仍是錯誤", () => {
  expect(
    runEventKind({ phase: "code", kind: "message", detail: fallback }),
  ).toBe("message");
  expect(runEventKind({ phase: "code", kind: "error", detail: null })).toBe(
    "error",
  );
});

it("只有開發與審查階段的 SDK 重連錯誤顯示為重連被拒", () => {
  const error = {
    kind: "error",
    detail: "Reconnecting... 1/4 (unexpected status 403 Forbidden)",
  };
  for (const phase of ["code", "review"]) {
    expect(eventLabels[runEventKind({ ...error, phase })]).toBe(
      "重連被拒（HTTP 403）",
    );
  }
  expect(runEventKind({ ...error, phase: "test" })).toBe("error");
  expect(runEventKind({ ...error, phase: "code", kind: "message" })).toBe(
    "message",
  );
});
