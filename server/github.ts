import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { downloadArchive } from "./archive-download.js";
import { githubHttpFetch } from "./github-http.js";
import { setupReadmeExcerpt } from "./setup-readme.js";
import { secrets } from "./config.js";
import {
  containsRepositoryCredential,
  sensitiveRepoPath,
  privateRepoPath,
} from "./repository-safety.js";
import { AppError } from "./policy.js";
import type { Project, Task } from "../shared/types.js";
import type { SourceAccess } from "./source-cache.js";
import { prEvidence } from "./pr-evidence.js";
import {
  validTargetBranch,
  type BranchCatalog,
} from "../shared/task-branch.js";
export class BranchUnavailable extends AppError {
  constructor(branch: string) {
    super(409, `目標分支「${branch}」不存在或已無法存取，請重新選擇分支`);
  }
}
const branchCacheMs = 60_000;
export class GitHub {
  // 同一個 GitHub App 可安裝在多個帳號或組織；依儲存庫找對應安裝。
  private installations = new Map<string, number>();
  private auth() {
    const s = secrets();
    if (!s.githubAppId || !s.githubPrivateKey)
      throw new AppError(503, "GitHub App 尚未完成設定");
    return { appId: s.githubAppId, privateKey: s.githubPrivateKey };
  }
  private octokit(installationId?: number) {
    return new Octokit({
      authStrategy: createAppAuth,
      auth: { ...this.auth(), ...(installationId ? { installationId } : {}) },
      request: { fetch: githubHttpFetch },
    });
  }
  async installation(repo: string) {
    const cached = this.installations.get(repo);
    if (cached) return cached;
    try {
      const id = (
        await this.octokit().apps.getRepoInstallation(this.parts(repo))
      ).data.id;
      this.installations.set(repo, id);
      return id;
    } catch {
      throw new AppError(403, `GitHub App 未安裝於 ${repo}`);
    }
  }
  // 不走快取直接問 GitHub 這個儲存庫現在在哪裡。改名或轉移後路徑會變，所以原路徑找不到時，
  // 再用固定編號（沒有編號就靠 GitHub 的舊路徑轉址）到每個安裝找一次。
  // 回傳 null 代表 App 在任何安裝都看不到它；只有明確的 404 才算，其他錯誤往外丟、下次再查。
  async locateRepo(repo: string, repoId?: number | null) {
    const app = this.octokit();
    const absent = (e: unknown) => (e as { status?: number }).status === 404;
    // App 真的裝在這個儲存庫才算；公開儲存庫任何安裝都讀得到，不能只看讀不讀得到。
    const installedAt = async (path: string) => {
      try {
        const p = this.parts(path);
        const installation = (await app.apps.getRepoInstallation(p)).data.id;
        const r = (await this.octokit(installation).repos.get(p)).data;
        this.installations.set(r.full_name, installation);
        return { id: r.id, full_name: r.full_name };
      } catch (e) {
        if (!absent(e)) throw e;
        return null;
      }
    };
    const direct = await installedAt(repo);
    // 編號不同代表原路徑已經換成另一個儲存庫，不能直接當成同一個。
    if (direct && (!repoId || direct.id === repoId)) return direct;
    this.installations.delete(repo);
    const installs = await app.paginate(app.apps.listInstallations, {
      per_page: 100,
    });
    for (const i of installs) {
      if (i.suspended_at) continue;
      const api = this.octokit(i.id);
      let path: string;
      try {
        path = (
          repoId
            ? await api.request("GET /repositories/{id}", { id: repoId })
            : await api.repos.get(this.parts(repo))
        ).data.full_name;
      } catch (e) {
        if (!absent(e)) throw e;
        continue;
      }
      // 沒被轉址就還是原路徑，上面已經確認過 App 不在那裡。
      if (path.toLowerCase() === repo.toLowerCase()) {
        if (repoId) return null;
        continue;
      }
      const moved = await installedAt(path);
      if (moved || repoId) return moved;
    }
    return null;
  }
  async client(repo: string) {
    return this.octokit(await this.installation(repo));
  }
  parts(repo: string) {
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new AppError(400, "儲存庫格式錯誤");
    return { owner, repo: name };
  }
  async repos() {
    const app = this.octokit();
    const installs = await app.paginate(app.apps.listInstallations, {
      per_page: 100,
    });
    const repos: Array<{
      id: number;
      full_name: string;
      default_branch: string;
      description: string;
    }> = [];
    for (const i of installs) {
      const api = this.octokit(i.id);
      const list = await api.paginate(
        api.apps.listReposAccessibleToInstallation,
        { per_page: 100 },
      );
      for (const r of list) {
        this.installations.set(r.full_name, i.id);
        repos.push({
          id: r.id,
          full_name: r.full_name,
          default_branch: r.default_branch,
          description: r.description ?? "",
        });
      }
    }
    return repos;
  }
  async base(project: Project) {
    if (!validTargetBranch(project.base_branch))
      throw new BranchUnavailable(project.base_branch);
    try {
      const branch = (
        await (
          await this.client(project.repo)
        ).repos.getBranch({
          ...this.parts(project.repo),
          branch: project.base_branch,
        })
      ).data;
      if (branch.name !== project.base_branch)
        throw new BranchUnavailable(project.base_branch);
      return branch.commit.sha;
    } catch (e) {
      if ((e as { status?: number }).status === 404)
        throw new BranchUnavailable(project.base_branch);
      throw e;
    }
  }
  async branches(project: Pick<Project, "repo">): Promise<BranchCatalog> {
    const api = await this.client(project.repo),
      p = this.parts(project.repo);
    const repo = (await api.repos.get(p)).data;
    const names: string[] = [];
    let truncated = false;
    for (let page = 1; page <= 5; page++) {
      const list = (await api.repos.listBranches({ ...p, per_page: 100, page }))
        .data;
      names.push(...list.map((b) => b.name).filter(validTargetBranch));
      if (list.length < 100) break;
      truncated = page === 5;
    }
    return { names, defaultBranch: repo.default_branch, truncated };
  }
  // 辨識每一批訊息都要分支清單，每次重抓要多打 2 到 6 次 GitHub API。
  // 清單只用來判斷訊息指名的分支在不在，短暫過期只會多一次人工確認；
  // 派工前仍會即時確認分支，看板選分支也一律即時查詢，不走這裡。
  private catalogs = new Map<string, { at: number; catalog: BranchCatalog }>();
  private async recentBranches(project: Project): Promise<BranchCatalog> {
    const hit = this.catalogs.get(project.repo);
    let catalog = hit?.catalog;
    if (!catalog || Date.now() - hit!.at > branchCacheMs) {
      catalog = await this.branches(project);
      this.catalogs.set(project.repo, { at: Date.now(), catalog });
    }
    return { ...catalog, names: [...catalog.names] };
  }
  async sourceAccess(project: Project, sha: string): Promise<SourceAccess> {
    // 命中快取仍重新驗證存取權；限單一儲存庫且只有 contents 唯讀。
    const installationId = await this.installation(project.repo);
    const repositoryId = (
      await (
        await this.client(project.repo)
      ).repos.get(this.parts(project.repo))
    ).data.id;
    const auth = await createAppAuth({
      ...this.auth(),
      installationId,
      request: new Octokit({ request: { fetch: githubHttpFetch } }).request,
    })({
      type: "installation",
      repositoryIds: [repositoryId],
      permissions: { contents: "read" },
    });
    return {
      repo: project.repo,
      sha,
      repositoryId,
      installationId,
      token: auth.token,
    };
  }
  /** 只取固定版本的建置設定；排除機密、符號連結與大型檔案。 */
  async setupContext(
    project: Project,
    sha: string,
  ): Promise<{
    files: Record<string, string>;
    locks: { path: string; sha: string }[];
    omissions?: { path: string; sha: string; reason: string }[];
  }> {
    const api = await this.client(project.repo),
      p = this.parts(project.repo);
    const tree = (
      await api.git.getTree({ ...p, tree_sha: sha, recursive: "1" })
    ).data;
    const isReadme = (path: string) => /(^|\/)README[^/]*$/i.test(path);
    const selected = tree.tree
      .filter(
        (x) =>
          x.type === "blob" &&
          x.mode !== "120000" &&
          !!x.path &&
          !privateRepoPath(x.path, project.sensitive_paths) &&
          !containsRepositoryCredential(x.path) &&
          (/(^|\/)(README[^/]*|AGENTS\.md|package\.json|global\.json|.*\.(csproj|sln|slnx)|Directory\.[^/]+|NuGet\.Config|pyproject\.toml|requirements[^/]*\.txt|pytest\.ini|tox\.ini|Makefile|Dockerfile|(?:docker-)?compose\.ya?ml|\.gitlab-ci\.yml)$/i.test(
            x.path,
          ) ||
            /^\.github\/workflows\/[^/]+\.ya?ml$/.test(x.path) ||
            /^(?:scripts|tests\/environment)\/[^/]+\.(?:sh|mjs|py)$/.test(
              x.path,
            )) &&
          !/(^|\/)(node_modules|vendor|obj|bin|dist|\.git)\//.test(x.path),
      )
      .sort(
        (a, b) =>
          Number(isReadme(a.path!)) - Number(isReadme(b.path!)) ||
          a.path!.localeCompare(b.path!),
      );
    if (tree.truncated || selected.length > 60)
      throw new Error(
        "專案建置設定超過自動判讀範圍；請在進階設定指定安裝與測試指令",
      );
    const files: Record<string, string> = {};
    const omissions: { path: string; sha: string; reason: string }[] = [];
    let total = 0,
      readmeBytes = 0;
    for (const entry of selected) {
      const readme = isReadme(entry.path!),
        maxSize = readme ? 256000 : 24000;
      const omit = (reason: string) =>
        omissions.push({ path: entry.path!, sha: entry.sha!, reason });
      if (
        readme &&
        ((entry.size ?? 0) > maxSize ||
          total >= 100000 ||
          readmeBytes + (entry.size ?? maxSize) > 1000000)
      ) {
        omit("說明文件超過讀取或上下文上限，未提供內容；請依其他建置設定判讀");
        continue;
      }
      if ((entry.size ?? 0) > maxSize)
        throw new Error(`建置設定 ${entry.path} 過大，請使用進階設定`);
      const r = (
        await api.repos.getContent({ ...p, path: entry.path!, ref: sha })
      ).data;
      if (!Array.isArray(r) && "content" in r) {
        const source = Buffer.from(r.content, "base64").toString("utf8");
        const size = Buffer.byteLength(source);
        if (readme) readmeBytes += size;
        if (size > maxSize) {
          if (!readme)
            throw new Error(`建置設定 ${entry.path} 過大，請使用進階設定`);
          omit("說明文件超過讀取上限，未提供內容");
          continue;
        }
        // 必須檢查完整已讀內容後才摘錄，避免漏掉省略段落中的憑證。
        if (
          !containsRepositoryCredential(source) &&
          !/<packageSourceCredentials\b|(?:password|api[_-]?key|token)\s*[:=]\s*["'][^$\s{][^"']{7,}["']/i.test(
            source,
          )
        ) {
          const content = readme
            ? setupReadmeExcerpt(source, Math.min(24000, 100000 - total))
            : source;
          total += Buffer.byteLength(content);
          if (total > 100000)
            throw new Error("專案建置設定過大，請使用進階設定");
          if (content !== source)
            omit("僅提供安裝、測試與環境相關原文摘錄，其餘內容已省略");
          if (content) files[entry.path!] = content;
        }
      }
    }
    // 鎖定檔只提供路徑與 Git blob 雜湊，避免將大型依賴清單送入 AI。
    const locks = tree.tree
      .filter(
        (x) =>
          x.type === "blob" &&
          x.mode !== "120000" &&
          !!x.path &&
          /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock|packages\.lock\.json)$/.test(
            x.path,
          ) &&
          !privateRepoPath(x.path!, project.sensitive_paths) &&
          !/(^|\/)node_modules\//.test(x.path!),
      )
      .map((x) => ({ path: x.path!, sha: x.sha! }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return { files, locks, ...(omissions.length ? { omissions } : {}) };
  }
  async context(project: Project, limit = { paths: 1500, chars: 15000 }) {
    const branches = await this.recentBranches(project);
    let sha: string;
    try {
      sha = await this.base(project);
      if (!branches.names.includes(project.base_branch))
        branches.names.push(project.base_branch);
    } catch (e) {
      if (!(e instanceof BranchUnavailable)) throw e;
      return {
        sha: "",
        paths: [] as string[],
        files: {} as Record<string, string>,
        truncated: false,
        branches,
        branchError: e.message,
      };
    }
    const api = await this.client(project.repo),
      p = this.parts(project.repo);
    const tree = (
      await api.git.getTree({ ...p, tree_sha: sha, recursive: "1" })
    ).data;
    const paths = tree.tree
      .filter((x) => x.type === "blob" && x.mode !== "120000")
      .map((x) => x.path)
      .filter(
        (path): path is string =>
          !!path &&
          !sensitiveRepoPath(path, project.sensitive_paths) &&
          !containsRepositoryCredential(path),
      )
      .slice(0, limit.paths);
    const selected = paths
      .filter((x) =>
        /^(README[^/]*|AGENTS\.md|CONTEXT\.md|package\.json|pyproject\.toml|.*\.csproj)$/i.test(
          x,
        ),
      )
      .slice(0, 8);
    const files: Record<string, string> = {};
    for (const path of selected) {
      const r = (await api.repos.getContent({ ...p, path, ref: sha })).data;
      if (!Array.isArray(r) && "content" in r) {
        const source = Buffer.from(r.content, "base64").toString("utf8");
        if (!containsRepositoryCredential(source))
          files[path] = source.slice(0, limit.chars);
      }
    }
    return {
      sha,
      paths,
      files,
      truncated: tree.truncated,
      branches,
      branchError: null,
    };
  }
  // 定期確認 PR 是否已在 GitHub 合併或關閉，補上延遲或遺失的 Webhook。
  async pullState(project: Project, number: number) {
    const api = await this.client(project.repo);
    const pr = (
      await api.pulls.get({ ...this.parts(project.repo), pull_number: number })
    ).data;
    return { state: pr.state, merged: pr.merged };
  }
  /** 追加修改用：PR 目前的分支、最新 commit 與目標分支。 */
  async pullHead(project: Project, number: number) {
    const api = await this.client(project.repo);
    const pr = (
      await api.pulls.get({ ...this.parts(project.repo), pull_number: number })
    ).data;
    return {
      state: pr.state,
      merged: pr.merged,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      base: pr.base.ref,
      sameRepo: pr.head.repo?.full_name === project.repo,
    };
  }
  /**
   * 追加修改：在 PR 分支目前的 commit（task.base_sha）上提交這次的變更，快轉分支並在 PR 說明附上這次追加。
   * 分支在這段期間被別人推進時拒絕，不覆寫他人的提交；重試時若分支已是同一份內容則視為完成。
   */
  async continuePr(
    project: Project,
    task: Task,
    prNumber: number,
    files: Array<{
      path: string;
      content: string | null;
      mode: "100644" | "100755";
    }>,
    report: string,
    assertCurrent: () => Promise<void> = async () => {},
  ) {
    const api = await this.client(project.repo),
      p = this.parts(project.repo),
      branch = task.branch!;
    const base = (await api.git.getCommit({ ...p, commit_sha: task.base_sha! }))
      .data;
    const tree = [];
    for (const f of files) {
      await assertCurrent();
      if (f.content === null)
        tree.push({
          path: f.path,
          mode: f.mode,
          type: "blob" as const,
          sha: null,
        });
      else {
        const blob = await api.git.createBlob({
          ...p,
          content: f.content,
          encoding: "base64",
        });
        tree.push({
          path: f.path,
          mode: f.mode,
          type: "blob" as const,
          sha: blob.data.sha,
        });
      }
    }
    if (!tree.length) throw new AppError(409, "沒有可提交的程式變更");
    await assertCurrent();
    const createdTree = (
      await api.git.createTree({ ...p, base_tree: base.tree.sha, tree })
    ).data;
    const current = (await api.git.getRef({ ...p, ref: `heads/${branch}` }))
      .data.object.sha;
    let publishedSha = current;
    if (current === task.base_sha) {
      await assertCurrent();
      const commit = (
        await api.git.createCommit({
          ...p,
          message: `追加：${task.title}\n\n關聯 #${task.issue_number}`,
          tree: createdTree.sha,
          parents: [task.base_sha!],
        })
      ).data;
      await api.git.updateRef({
        ...p,
        ref: `heads/${branch}`,
        sha: commit.sha,
        force: false,
      });
      publishedSha = commit.sha;
    } else {
      const head = (await api.git.getCommit({ ...p, commit_sha: current }))
        .data;
      if (head.tree.sha !== createdTree.sha)
        throw new AppError(
          409,
          "PR 分支在這段期間有新的提交，為避免覆寫，請重新確認後以最新內容為基底再追加",
        );
    }
    await assertCurrent();
    const pr = (await api.pulls.get({ ...p, pull_number: prNumber })).data;
    const marker = `<!-- agentflow:${task.id}:${task.version} -->`;
    if (!pr.body?.includes(marker))
      await api.pulls.update({
        ...p,
        pull_number: prNumber,
        body: `${pr.body ?? ""}\n\n---\n\n## 追加：${task.title}\n${task.summary}\n\n${report}\n\n${prEvidence(
          project.repo,
          publishedSha,
          files.filter((f) => f.content !== null).map((f) => f.path),
          project.sensitive_paths,
        )}\n\nCloses #${task.issue_number}\n\n${marker}`.slice(0, 65000),
      });
    return pr;
  }
  async commentIssue(project: Project, issueNumber: number, body: string) {
    const api = await this.client(project.repo);
    await api.issues.createComment({
      ...this.parts(project.repo),
      issue_number: issueNumber,
      body: body.slice(0, 60000),
    });
  }
  async ensureIssue(project: Project, task: Task) {
    const api = await this.client(project.repo),
      p = this.parts(project.repo),
      marker = `<!-- agentflow:${task.id} -->`;
    const body = `${marker}\n\n${task.summary}\n\n目標分支：${task.target_branch ?? project.base_branch}\n\n## 驗收條件\n${task.acceptance.map((x) => `- [ ] ${x}`).join("\n")}\n\n由 chat2pr 整理；需求版本 ${task.version}。`;
    const update = async (number: number) => {
      const issue = (
        await api.issues.update({
          ...p,
          issue_number: number,
          title: task.title,
          body,
        })
      ).data;
      return { number: issue.number, url: issue.html_url };
    };
    if (task.issue_number) return update(task.issue_number);
    for await (const page of api.paginate.iterator(api.issues.listForRepo, {
      ...p,
      state: "all",
      per_page: 100,
    })) {
      const found = page.data.find(
        (i) => !i.pull_request && i.body?.includes(marker),
      );
      if (found) return update(found.number);
    }
    const issue = (
      await api.issues.create({
        ...p,
        title: task.title,
        body,
      })
    ).data;
    return { number: issue.number, url: issue.html_url };
  }
  // 大型儲存庫的封存檔可達數百 MB，以串流交給執行器，不整份讀入記憶體。
  async archive(project: Project, sha: string) {
    const { token } = await createAppAuth({
      ...this.auth(),
      installationId: await this.installation(project.repo),
      request: new Octokit({ request: { fetch: githubHttpFetch } }).request,
    })({ type: "installation" });
    const { owner, repo } = this.parts(project.repo);
    return downloadArchive(
      `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`,
      token,
    );
  }
  async findPr(project: Project, branch: string) {
    const p = this.parts(project.repo);
    return (
      await (
        await this.client(project.repo)
      ).pulls.list({
        ...p,
        state: "all",
        head: `${p.owner}:${branch}`,
      })
    ).data[0];
  }
  async publish(
    project: Project,
    task: Task,
    files: Array<{
      path: string;
      content: string | null;
      mode: "100644" | "100755";
    }>,
    report: string,
    assertCurrent: () => Promise<void> = async () => {},
  ) {
    const api = await this.client(project.repo),
      p = this.parts(project.repo),
      branch = task.branch!;
    const previous = await this.findPr(project, branch);
    await assertCurrent();
    if (previous) return previous;
    const base = (await api.git.getCommit({ ...p, commit_sha: task.base_sha! }))
      .data;
    const tree = [];
    for (const f of files) {
      await assertCurrent();
      if (f.content === null) {
        tree.push({
          path: f.path,
          mode: f.mode,
          type: "blob" as const,
          sha: null,
        });
      } else {
        const blob = await api.git.createBlob({
          ...p,
          content: f.content,
          encoding: "base64",
        });
        tree.push({
          path: f.path,
          mode: f.mode,
          type: "blob" as const,
          sha: blob.data.sha,
        });
      }
    }
    if (!tree.length) throw new AppError(409, "沒有可提交的程式變更");
    await assertCurrent();
    const createdTree = (
      await api.git.createTree({ ...p, base_tree: base.tree.sha, tree })
    ).data;
    await assertCurrent();
    const commit = (
      await api.git.createCommit({
        ...p,
        message: `實作：${task.title}\n\n關聯 #${task.issue_number}`,
        tree: createdTree.sha,
        parents: [task.base_sha!],
      })
    ).data;
    await assertCurrent();
    let publishedSha = commit.sha;
    try {
      await api.git.createRef({
        ...p,
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      });
    } catch (e) {
      const existing = await api.git.getRef({ ...p, ref: `heads/${branch}` });
      const old = (
        await api.git.getCommit({ ...p, commit_sha: existing.data.object.sha })
      ).data;
      if (old.tree.sha !== createdTree.sha)
        throw new AppError(409, "分支已有不同內容，請人工確認");
      publishedSha = existing.data.object.sha;
    }
    await assertCurrent();
    return (
      await api.pulls.create({
        ...p,
        head: branch,
        base: task.target_branch ?? project.base_branch,
        title: task.title,
        body: `## 需求\n${task.summary}\n\n${report}\n\n${prEvidence(
          project.repo,
          publishedSha,
          files.filter((f) => f.content !== null).map((f) => f.path),
          project.sensitive_paths,
        )}\n\nCloses #${task.issue_number}\n\n<!-- agentflow:${task.id}:${task.version} -->\n由 chat2pr 建立，請人工檢視後合併。`,
      })
    ).data;
  }
  // 把群組要求記住的專案知識加進 AGENTS.md；固定使用一條分支與一個 PR，
  // 已有開啟中的 PR 就追加 commit，合併後下一批從新的基底重開。
  async knowledgePr(
    project: Project,
    items: Array<{ id: string; content: string }>,
  ) {
    const api = await this.client(project.repo),
      p = this.parts(project.repo),
      branch = "agentflow/agents-memory",
      path = "AGENTS.md",
      heading = "## LINE-AgentFlow 專案記憶";
    const open = (
      await api.pulls.list({
        ...p,
        state: "open",
        head: `${p.owner}:${branch}`,
      })
    ).data[0];
    const parent = open
      ? (await api.git.getRef({ ...p, ref: `heads/${branch}` })).data.object.sha
      : await this.base(project);
    let current = "";
    try {
      const file = (await api.repos.getContent({ ...p, path, ref: parent }))
        .data;
      if (!Array.isArray(file) && "content" in file)
        current = Buffer.from(file.content, "base64").toString("utf8");
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
    const added = items.filter(
      (i) => !current.includes(`agentflow-knowledge:${i.id}`),
    );
    if (added.length) {
      const lines = added.map(
        (i) =>
          `- ${i.content.replace(/\s+/g, " ").trim()} <!-- agentflow-knowledge:${i.id} -->`,
      );
      // 專案記憶段落由本服務建立並放在檔尾，追加時直接接在最後。
      const next = current.includes(heading)
        ? `${current.trimEnd()}\n${lines.join("\n")}\n`
        : `${current.trimEnd()}${current ? "\n\n" : ""}${heading}\n\n以下規範來自 LINE 群組要求記住的內容，由管理者合併後生效。\n\n${lines.join("\n")}\n`;
      const base = (await api.git.getCommit({ ...p, commit_sha: parent })).data;
      const blob = await api.git.createBlob({
        ...p,
        content: Buffer.from(next).toString("base64"),
        encoding: "base64",
      });
      const tree = await api.git.createTree({
        ...p,
        base_tree: base.tree.sha,
        tree: [{ path, mode: "100644", type: "blob", sha: blob.data.sha }],
      });
      const commit = await api.git.createCommit({
        ...p,
        message: "更新 AGENTS.md：加入 LINE 群組專案記憶",
        tree: tree.data.sha,
        parents: [parent],
      });
      try {
        await api.git.updateRef({
          ...p,
          ref: `heads/${branch}`,
          sha: commit.data.sha,
          force: !open,
        });
      } catch {
        await api.git.createRef({
          ...p,
          ref: `refs/heads/${branch}`,
          sha: commit.data.sha,
        });
      }
    }
    if (open) return open;
    return (
      await api.pulls.create({
        ...p,
        head: branch,
        base: project.base_branch,
        title: "更新 AGENTS.md：LINE 群組專案記憶",
        body: `把 LINE 群組要求記住的開發規範與背景知識寫進 AGENTS.md，之後 Codex 每次修改此專案都會遵守。\n\n${items.map((i) => `- ${i.content}`).join("\n")}\n\n由 chat2pr 建立，請人工檢視後合併；不需要的項目可直接在 PR 中刪除。`,
      })
    ).data;
  }
}
