import { it, expect, vi } from "vitest";
import { prEvidence } from "../server/pr-evidence.js";
import { GitHub } from "../server/github.js";
import type { Project, Task } from "../shared/types.js";

const sha = "a".repeat(40),
  existingSha = "b".repeat(40);
it("前後截圖與驗收文件固定在提交版本，並排預覽不重複", () => {
  const body = prEvidence("test/repo", sha, [
    "docs/wip-after-390.png",
    "docs/wip-before-390.png",
    "docs/驗收 (手機).md",
  ]);
  expect(body).toContain("| 修改前 | 修改後 |");
  expect(body.match(/!\[/g)).toHaveLength(2);
  expect(body).toContain(`/blob/${sha}/docs/wip-before-390.png?raw=true`);
  expect(body).toContain("%E9%A9%97%E6%94%B6%20%28%E6%89%8B%E6%A9%9F%29.md");
  expect(body).toContain("測試方式與限制");
});
it("排除敏感附件與不安全路徑，不將 SVG 或一般素材當截圖", () => {
  const body = prEvidence(
    "test/repo",
    sha,
    [
      "docs/private/report.md",
      "docs/../secret.png",
      "docs/.env.png",
      "docs/a.svg",
      "assets/logo.png",
      "docs/x\n.png",
      "docs/shot.png",
    ],
    ["docs/private/**"],
  );
  expect(body).toContain("docs/shot.png");
  for (const bad of ["private", "secret", ".env", ".svg", "logo", "x\n"])
    expect(body).not.toContain(bad);
});
it("沒有附件不捏造圖片，很多附件限制預覽與說明長度", () => {
  expect(prEvidence("test/repo", sha, ["src/a.ts"])).toBe("");
  const body = prEvidence(
    "test/repo",
    sha,
    Array.from({ length: 80 }, (_, i) => `docs/${i}-after.png`),
  );
  expect(body.match(/!\[/g)).toHaveLength(8);
  expect(body).toContain("Files changed");
  expect(body.length).toBeLessThan(25000);
});
it.each([false, true])(
  "實際發布帶入附件，既有分支使用真正的遠端提交（重試=%s）",
  async (retry) => {
    const github = new GitHub();
    const create = vi.fn(async () => ({ data: { number: 3 } }));
    github.findPr = vi.fn(async () => undefined!);
    github.client = vi.fn(
      async () =>
        ({
          git: {
            getCommit: async () => ({ data: { tree: { sha: "tree" } } }),
            createBlob: async () => ({ data: { sha: "blob" } }),
            createTree: async () => ({ data: { sha: "tree" } }),
            createCommit: async () => ({ data: { sha } }),
            createRef: async () => {
              if (retry) throw new Error("分支已存在");
            },
            getRef: async () => ({ data: { object: { sha: existingSha } } }),
          },
          pulls: { create },
        }) as never,
    );
    await github.publish(
      {
        repo: "test/repo",
        base_branch: "main",
        sensitive_paths: [],
      } as unknown as Project,
      {
        branch: "agentflow/test",
        target_branch: "release/2026",
        base_sha: "base",
        title: "驗收",
        summary: "修改",
        id: "task",
        version: 1,
        issue_number: 2,
      } as Task,
      [
        { path: "docs/after.png", content: "aW1hZ2U=", mode: "100644" },
        { path: "docs/deleted.png", content: null, mode: "100644" },
      ],
      "測試通過",
    );
    const body = (create.mock.calls[0] as unknown as [{ body: string }])[0]
      .body;
    expect(create).toHaveBeenCalledWith(expect.objectContaining({base:"release/2026"}));
    expect(body).toContain(
      `/blob/${retry ? existingSha : sha}/docs/after.png?raw=true`,
    );
    expect(body).not.toContain("deleted.png");
    expect(body).toContain("Closes #2");
  },
);
it("重試已有 PR 不覆寫管理者編輯的內容", async () => {
  const github = new GitHub(),
    api = vi.fn(async () => ({}) as never);
  github.client = api;
  const previous = { number: 3, body: "管理者補充" };
  github.findPr = async () => previous as never;
  expect(
    await github.publish(
      { repo: "test/repo" } as unknown as Project,
      { branch: "test" } as Task,
      [],
      "新紀錄",
    ),
  ).toBe(previous);
});
