import { expect, it } from "vitest";
import { Octokit } from "@octokit/rest";
import { GitHub, BranchUnavailable } from "../server/github.js";
import type { Project } from "../shared/types.js";
const project: Project = {
  id: "branch-test",
  name: "分支測試",
  repo: "test/repo",
  base_branch: "main",
  sensitive_paths: [],
  config_version: 1,
  description: "分支測試",
  image: "測試映像",
  install_command: "",
  test_command: "",
  enabled: true,
  validated_at: "2026-11-11",
  validation_error: null,
  created_at: "2026-11-11",
};
function provider(handle: (url: URL) => Response) {
  const requests: string[] = [];
  const api = new Octokit({
    request: {
      fetch: async (url: string) => {
        requests.push(url);
        return handle(new URL(url));
      },
    },
  });
  const github = new GitHub();
  github.client = async () => api;
  return { github, requests };
}
it("分頁讀取真實分支與遠端預設，含斜線分支以分支 API 固定 commit", async () => {
  const { github, requests } = provider((url) => {
    const path = decodeURIComponent(url.pathname);
    if (path === "/repos/test/repo")
      return Response.json({ default_branch: "develop" });
    if (path === "/repos/test/repo/branches")
      return Response.json(
        url.searchParams.get("page") === "1"
          ? Array.from({ length: 100 }, (_, i) => ({ name: `branch-${i}` }))
          : [{ name: "release/2026" }],
      );
    if (path === "/repos/test/repo/branches/release/2026")
      return Response.json({
        name: "release/2026",
        commit: { sha: "fixed-sha" },
      });
    throw Error("非預期測試請求");
  });
  const list = await github.branches(project);
  expect(list.names).toHaveLength(101);
  expect(list.defaultBranch).toBe("develop");
  expect(list.truncated).toBe(false);
  expect(await github.base({ ...project, base_branch: "release/2026" })).toBe(
    "fixed-sha",
  );
  expect(requests.every((url) => !url.includes("/commits/"))).toBe(true);
});
it.each(["v1.2.3", "a".repeat(40)])(
  "不存在的分支 %s 不改用標籤或 commit",
  async (name) => {
    const { github, requests } = provider(() =>
      Response.json({ message: "Not Found" }, { status: 404 }),
    );
    await expect(
      github.base({ ...project, base_branch: name }),
    ).rejects.toBeInstanceOf(BranchUnavailable);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("/branches/");
  },
);
it("遠端更名回傳另一個分支時不能靜默採用", async () => {
  const { github } = provider(() =>
    Response.json({ name: "develop", commit: { sha: "other" } }),
  );
  await expect(github.base(project)).rejects.toThrow("目標分支");
});
it("設定分支已消失仍提供實際候選分支，不拿別的分支內容當證據", async () => {
  const { github, requests } = provider((url) => {
    if (url.pathname === "/repos/test/repo")
      return Response.json({ default_branch: "develop" });
    if (url.pathname === "/repos/test/repo/branches")
      return Response.json([{ name: "develop" }]);
    return Response.json({ message: "Not Found" }, { status: 404 });
  });
  const context = await github.context(project);
  expect(context).toMatchObject({
    sha: "",
    files: {},
    paths: [],
    branches: { names: ["develop"] },
  });
  expect(context.branchError).toContain("main");
  expect(
    requests.every(
      (url) => !url.includes("/git/trees/") && !url.includes("/contents/"),
    ),
  ).toBe(true);
});
it("辨識短時間內重複取用分支清單只問 GitHub 一次，看板選分支仍即時查詢", async () => {
  const { github, requests } = provider((url) => {
    if (url.pathname === "/repos/test/repo")
      return Response.json({ default_branch: "develop" });
    if (url.pathname === "/repos/test/repo/branches")
      return Response.json([{ name: "develop" }]);
    return Response.json({ message: "Not Found" }, { status: 404 });
  });
  const lists = () =>
    requests.filter((url) => new URL(url).pathname.endsWith("/branches"))
      .length;
  const first = await github.context(project);
  first.branches.names.push("只改到這一次的結果");
  const second = await github.context(project);
  expect(lists()).toBe(1);
  expect(second.branches.names).toEqual(["develop"]);
  // 設定分支在不在，每次都即時確認。
  expect(requests.filter((url) => url.includes("/branches/main"))).toHaveLength(
    2,
  );
  await github.branches(project);
  expect(lists()).toBe(2);
});
