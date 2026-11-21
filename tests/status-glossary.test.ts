import { expect, it } from "vitest";
import {
  groupStatus,
  isUnnamedLineGroup,
  projectStatus,
} from "../shared/status-glossary.js";
import type { Project } from "../shared/types.js";
it("專案同時有多個條件時顯示下一步能處理的狀態", () => {
  const p = { enabled: true, validated_at: "2026-01-01" };
  expect(
    projectStatus({ ...p, repo_missing_at: "2026-01-02" }, false, true),
  ).toBe("missing");
  expect(
    projectStatus(
      { ...p, setup_input: { id: "demo" } as Project["setup_input"] },
      false,
      true,
    ),
  ).toBe("question");
  expect(projectStatus({ ...p, validated_at: null }, false, true)).toBe(
    "failed",
  );
  expect(projectStatus({ ...p, validated_at: null }, false, false)).toBe(
    "unverified",
  );
  expect(projectStatus({ ...p, enabled: false }, false, false)).toBe(
    "disabled",
  );
  expect(projectStatus(p, false, false)).toBe("unbound");
  expect(projectStatus(p, true, false)).toBe("ready");
  expect(
    projectStatus(
      { ...p, validation_progress: "你的專案正在等待執行器。" },
      true,
      false,
    ),
  ).toBe("validating");
});
it("群組狀態優先說明離開、停用與辨識異常", () => {
  const g = { enabled: true, triage_failures: 0, triage_error: null };
  expect(
    groupStatus({ ...g, left_at: "2026-01-01", enabled: false }, false),
  ).toBe("left");
  expect(groupStatus({ ...g, enabled: false, triage_failures: 3 }, true)).toBe(
    "disabled",
  );
  expect(groupStatus({ ...g, triage_failures: 3 }, true)).toBe("stopped");
  expect(groupStatus({ ...g, triage_error: "範例辨識失敗" }, true)).toBe(
    "error",
  );
  expect(groupStatus(g, false)).toBe("unbound");
  expect(groupStatus(g, true)).toBe("ready");
});

it("只將空白或符合自身預設名稱的 LINE 群組判為未命名", () => {
  const line = { platform: "line", id: "Cfictional6d7e8f" } as const;
  expect(isUnnamedLineGroup({ ...line, name: "群組 6d7e8f" })).toBe(true);
  expect(isUnnamedLineGroup({ ...line, name: " " })).toBe(true);
  expect(isUnnamedLineGroup({ ...line, name: "群組 abcdef" })).toBe(false);
  expect(isUnnamedLineGroup({ ...line, name: "範例群組" })).toBe(false);
  expect(
    isUnnamedLineGroup({ ...line, platform: "discord", name: "群組 6d7e8f" }),
  ).toBe(false);
});
