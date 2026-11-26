import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { buffer } from "node:stream/consumers";
import { gunzipSync } from "node:zlib";
import { Octokit } from "@octokit/rest";
import { extract } from "tar-stream";
import { expect, it, vi } from "vitest";
import { createGitHubProvider } from "../scripts/acceptance/flows/github-provider.js";
import { GitHub } from "../server/github.js";
import type { Project, Task } from "../shared/types.js";

vi.mock("../server/config.js", () => ({
  secrets: () => { throw new Error("驗收不應讀取任何憑證"); },
}));

async function serve(options?: Parameters<typeof createGitHubProvider>[0]) {
  const { fixture, state, handler, readPr } = await createGitHubProvider(options);
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("未取得驗收埠號");
  const origin = "http://127.0.0.1:" + address.port;
  const api = new Octokit({ baseUrl: origin });
  const github = new GitHub();
  github.client = async () => api;
  const project: Project = {
    id: "lantern", name: "燈會票務", repo: fixture.repo,
    base_branch: fixture.defaultBranch, config_version: 1, description: "虛構票務專案",
    image: "", install_command: "", test_command: "", sensitive_paths: [],
    enabled: true, validated_at: null, validation_error: null, created_at: "2026-01-01",
  };
  const task: Task = {
    id: "ticket-sum", project_id: project.id, group_id: "lantern-volunteers",
    title: "新增票數摘要", summary: "提供各批票數摘要", acceptance: ["輸出合計"],
    target_branch: fixture.defaultBranch, base_sha: fixture.baseSha, branch: "work/ticket-sum",
    pending_paths: [], approved_paths: [], risk_reasons: [], missing: [], suggestions: [],
    source_ids: [], status: "reviewing", version: 1, approved_version: 1,
    issue_number: null, issue_url: null, pr_number: null, pr_url: null, parent_id: null,
    last_error: null, mode: "change", answer: null, created_at: "2026-01-01", updated_at: "2026-01-01",
  };
  return {
    api, github, project, task, fixture, state, origin, readPr,
    parts: github.parts(fixture.repo),
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

async function archive(origin: string, repo: string, sha: string) {
  const response = await fetch(`${origin}/repos/${repo}/tarball/${sha}`);
  expect(response.status).toBe(200);
  const tar = extract();
  tar.end(gunzipSync(Buffer.from(await response.arrayBuffer())));
  const files = new Map<string, Buffer>();
  for await (const entry of tar) {
    const bytes = await buffer(entry);
    if (entry.header.type === "file") {
      expect(entry.header.name).toMatch(/^[\w.-]+\/.+/);
      files.set(entry.header.name.slice(entry.header.name.indexOf("/") + 1), bytes);
    }
  }
  return files;
}

it("安裝、分支、context 與指定 SHA 封存使用同一份燈會票務 fixture", async () => {
  await using peer = await serve();
  const { api, github, project, parts, fixture } = peer;
  expect((await api.apps.getRepoInstallation(parts)).data.id).toBe(fixture.installationId);
  expect((await api.apps.listInstallations()).data.map(i => i.id)).toContain(fixture.installationId);
  expect((await api.apps.listReposAccessibleToInstallation()).data.repositories[0]).toMatchObject({
    id: fixture.repositoryId, full_name: fixture.repo, default_branch: fixture.defaultBranch,
  });
  expect((await api.apps.createInstallationAccessToken({ installation_id: fixture.installationId })).data.token)
    .toBeTruthy();
  expect(await github.base(project)).toBe(fixture.baseSha);
  const context = await github.context(project);
  expect(context.sha).toBe(fixture.baseSha);
  expect(context.files["package.json"]).toContain("lantern-tickets");
  const files = await archive(peer.origin, fixture.repo, fixture.baseSha);
  const paths = ["package-lock.json", "package.json", "tickets.mjs", "tickets.test.mjs"];
  expect([...files.keys()].sort()).toEqual(paths);
  for (const path of paths) {
    const bytes = await readFile(new URL("../scripts/acceptance/fixtures/lantern-tickets/" + path, import.meta.url));
    expect(files.get(path)).toEqual(bytes);
  }
  expect((await fetch(peer.origin + "/repos/other/unknown")).status).toBe(404);
  expect((await fetch(peer.origin + "/repos/" + fixture.repo + "/tarball/unknown")).status).toBe(404);
});

const summaryPath = "reports/摘要.bin";
const summary = Buffer.from([0, 42, 128, 255]);
const changes = [
  { path: summaryPath, content: summary.toString("base64"), mode: "100755" },
  { path: "tickets.test.mjs", content: null, mode: "100644" },
] satisfies Parameters<GitHub["publish"]>[2];

it("Issue 重試沿用編號；PR head 的 commit、tree、blob 與封存保留實際檔案，追加後可回查舊版", async () => {
  await using peer = await serve();
  const { api, github, project, task, fixture, parts } = peer;
  const issue = await github.ensureIssue(project, task);
  task.title = "整理票數摘要";
  expect(await github.ensureIssue(project, task)).toEqual(issue);
  task.issue_number = issue.number;
  await github.commentIssue(project, issue.number, "已核對批次");
  expect((await api.issues.get({ ...parts, issue_number: issue.number })).data.title).toBe(task.title);
  expect((await api.issues.listComments({ ...parts, issue_number: issue.number })).data.map(c => c.body))
    .toEqual(["已核對批次"]);

  const pr = await github.publish(project, task, changes, "初版");
  expect(pr.number).not.toBe(issue.number);
  expect(pr.body).toContain("Closes #" + issue.number);
  const sha = pr.head.sha;
  expect(await github.pullHead(project, pr.number)).toMatchObject({
    headRef: task.branch, headSha: sha, base: fixture.defaultBranch, sameRepo: true,
  });
  const commit = (await api.git.getCommit({ ...parts, commit_sha: sha })).data;
  expect(commit.parents.map(p => p.sha)).toEqual([fixture.baseSha]);
  const tree = (await api.git.getTree({ ...parts, tree_sha: commit.tree.sha, recursive: "1" })).data;
  const blob = tree.tree.find(f => f.path === summaryPath);
  expect(blob).toMatchObject({ mode: "100755", type: "blob", size: summary.length });
  expect((await api.git.getBlob({ ...parts, file_sha: blob!.sha! })).data.content).toBe(summary.toString("base64"));
  const files = await archive(peer.origin, fixture.repo, sha);
  expect([...files.keys()].sort()).toEqual(["package-lock.json", "package.json", summaryPath, "tickets.mjs"]);
  expect(files.get(summaryPath)).toEqual(summary);
  expect((await github.publish(project, task, changes, "重試")).number).toBe(pr.number);
  expect(await github.findPr(project, "work/other")).toBeUndefined();
  task.base_sha = sha;
  task.version++;
  await github.continuePr(project, task, pr.number, [{ ...changes[0], content: "" }], "追加空摘要");
  const head = await github.pullHead(project, pr.number);
  expect(head.headSha).not.toBe(sha);
  expect(await peer.readPr(pr.number)).toMatchObject({
    number: pr.number, head: task.branch, headSha: head.headSha, base: fixture.defaultBranch,
    body: expect.stringContaining("追加空摘要"), deletedFiles: ["tickets.test.mjs"],
  });
  expect((await peer.readPr(pr.number))?.files).toEqual({ [summaryPath]: "" });
  expect((await github.findPr(project, task.branch!))?.body).toContain("追加空摘要");
  expect((await github.compareCommits(project, fixture.baseSha, head.headSha)).aheadBy).toBe(2);
  expect((await github.compareCommits(project, head.headSha, head.headSha)).aheadBy).toBe(0);
  expect((await archive(peer.origin, fixture.repo, head.headSha)).get(summaryPath)).toEqual(Buffer.alloc(0));
  expect((await archive(peer.origin, fixture.repo, sha)).get(summaryPath)).toEqual(summary);
  expect(await github.base(project)).toBe(fixture.baseSha);
});

it("注入缺少 PR 時仍可查驗已提交的分支；解除故障後重試沿用該提交", async () => {
  await using peer = await serve({ omitPullRequest: true });
  const { github, project, task, state, fixture, api, parts } = peer;
  task.issue_number = (await github.ensureIssue(project, task)).number;
  await expect(github.publish(project, task, changes, "故障注入")).rejects.toMatchObject({ status: 503 });
  expect(await github.findPr(project, task.branch!)).toBeUndefined();
  expect(state.pulls.size).toBe(0);
  expect(await peer.readPr(1)).toBeNull();
  const head = (await api.git.getRef({ ...parts, ref: "heads/" + task.branch })).data.object.sha;
  expect((await archive(peer.origin, fixture.repo, head)).get(summaryPath)).toEqual(summary);
  await expect(api.git.updateRef({ ...parts, ref: "heads/" + task.branch, sha: fixture.baseSha, force: false }))
    .rejects.toMatchObject({ status: 422 });
  state.omitPullRequest = false;
  const pr = await github.publish(project, task, changes, "重試");
  expect(pr.head.sha).toBe(head);
  expect(state.pulls.size).toBe(1);
  state.omitPullRequest = true;
  expect(await peer.readPr(pr.number)).toBeNull();
  expect(await github.findPr(project, task.branch!)).toBeUndefined();
  await expect(github.pullState(project, pr.number)).rejects.toMatchObject({ status: 404 });
  state.omitPullRequest = false;
  expect(await github.pullState(project, pr.number)).toEqual({ state: "open", merged: false });
});
