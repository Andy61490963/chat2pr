import { expect, it } from "vitest";
import { groupStatus, projectStatus } from "../shared/status-glossary.js";
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
