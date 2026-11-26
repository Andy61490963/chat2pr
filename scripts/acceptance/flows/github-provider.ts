import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener } from "node:http";
import { buffer } from "node:stream/consumers";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { z } from "zod";
import { validTargetBranch } from "../../../shared/task-branch.js";

const repo = "lantern-example/lantern-tickets";
const defaultBranch = "main";
const repositoryId = 71001;
const installationId = 72001;
const files = ["package.json", "package-lock.json", "tickets.mjs", "tickets.test.mjs"] as const;
const webUrl = "https://github.example.invalid/" + repo;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function lookup<T>(value: T | undefined): T {
  if (value === undefined) throw new HttpError(404, "找不到驗收資源");
  return value;
}

function requireValid(condition: boolean, message: string): void {
  if (!condition) throw new HttpError(422, message);
}

const filePath = z.string().refine(path =>
  !/[\\:\x00-\x1f\x7f]/.test(path) &&
  path.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
);
const treeChange = z.object({
  path: filePath,
  type: z.literal("blob"),
  mode: z.enum(["100644", "100755"]),
  sha: z.string().nullable(),
});
type TreeEntry = Omit<z.infer<typeof treeChange>, "sha"> & { sha: string };
type Commit = { sha: string; tree: { sha: string }; parents: { sha: string }[]; message: string };

function objectId(type: string, bytes: Buffer) {
  return createHash("sha1").update(type + " " + bytes.length + "\0").update(bytes).digest("hex");
}

function createObjects() {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, TreeEntry[]>();
  const commits = new Map<string, Commit>();
  const refs = new Map<string, string>();

  function writeBlob(bytes: Buffer) {
    const sha = objectId("blob", bytes);
    blobs.set(sha, bytes);
    return sha;
  }

  function writeTree(entries: TreeEntry[]) {
    // 同一棵樹即使以不同順序上傳，重試時也應取得同一個識別碼。
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    const sha = objectId("tree", Buffer.from(JSON.stringify(entries.map(e => [e.path, e.mode, e.sha]))));
    trees.set(sha, entries);
    return sha;
  }

  function writeCommit(tree: string, parents: string[], message: string) {
    const sha = objectId("commit", Buffer.from(JSON.stringify([tree, parents, message])));
    const commit = { sha, tree: { sha: tree }, parents: parents.map(sha => ({ sha })), message };
    commits.set(sha, commit);
    return commit;
  }

  function commitAt(ref: string) {
    return lookup(commits.get(refs.get(ref) ?? ref));
  }

  function ancestors(sha: string) {
    const seen = new Set<string>();
    const pending = [sha];
    while (pending.length) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...lookup(commits.get(current)).parents.map(p => p.sha));
    }
    return seen;
  }

  return { blobs, trees, commits, refs, writeBlob, writeTree, writeCommit, commitAt, ancestors };
}

async function tarball(sha: string, tree: TreeEntry[], blobs: Map<string, Buffer>) {
  const tar = pack();
  const bytes = buffer(tar);
  for (const entry of tree) {
    tar.entry({
      name: "lantern-tickets-" + sha + "/" + entry.path,
      mode: parseInt(entry.mode, 8) & 0o777,
      mtime: new Date(0),
    }, lookup(blobs.get(entry.sha)));
  }
  tar.finalize();
  return gzipSync(await bytes);
}

type Issue = { number: number; title: string; body: string; state: "open" | "closed"; html_url: string };
type Pull = Issue & { head: string; base: string; merged: boolean };
type Comment = { id: number; body: string };

const issueFields = z.object({
  title: z.string(), body: z.string(), state: z.enum(["open", "closed"]),
});
const newIssue = issueFields.pick({ title: true }).extend({ body: z.string().default("") });
const newPull = newIssue.extend({ head: z.string(), base: z.string() });

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.method !== "POST" && request.method !== "PATCH") return;
  const bytes = await buffer(request);
  if (!bytes.length) return {};
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new HttpError(400, "無法解析 JSON");
  }
}

/** 每次建立一個獨立的虛構儲存庫，由呼叫者把 handler 掛到驗收 HTTP 伺服器。 */
export async function createGitHubProvider(options: { omitPullRequest?: boolean } = {}) {
  const git = createObjects();
  const seed = await Promise.all(files.map(async (path): Promise<TreeEntry> => {
    const bytes = await readFile(new URL("../fixtures/lantern-tickets/" + path, import.meta.url));
    return { path, type: "blob", mode: "100644", sha: git.writeBlob(bytes) };
  }));
  const baseSha = git.writeCommit(git.writeTree(seed), [], "建立燈會票務驗收專案").sha;
  git.refs.set(defaultBranch, baseSha);
  const fixture = { repo, repositoryId, installationId, defaultBranch, baseSha, files };
  const state = {
    issues: new Map<number, Issue>(),
    pulls: new Map<number, Pull>(),
    comments: new Map<number, Comment[]>(),
    refs: git.refs, commits: git.commits, trees: git.trees, blobs: git.blobs,
    omitPullRequest: options.omitPullRequest ?? false,
  };
  let nextNumber = 1;
  let nextComment = 1;
  const repository = {
    id: repositoryId, full_name: repo, default_branch: defaultBranch, description: "燈會票務驗收專案",
  };

  function pullView(pull: Pull) {
    const side = (ref: string) => ({ ref, sha: lookup(git.refs.get(ref)), repo: repository });
    return { ...pull, head: side(pull.head), base: side(pull.base) };
  }

  function visiblePulls(): ReadonlyMap<number, Pull> {
    return state.omitPullRequest ? new Map<number, Pull>() : state.pulls;
  }

  function refView(branch: string) {
    return { ref: "refs/heads/" + branch, object: { type: "commit", sha: lookup(git.refs.get(branch)) } };
  }

  /** 供驗收讀取 PR 分支真正提交的文字差異；二進位原文可用相同 headSha 下載。 */
  async function readPr(number: number) {
    const pull = visiblePulls().get(number);
    if (!pull) return null;
    const head = git.commitAt(pull.head);
    const before = git.ancestors(git.commitAt(pull.base).sha);
    const common = [...git.ancestors(head.sha)].filter(sha => before.has(sha));
    const older = new Set(common.flatMap(sha => lookup(git.commits.get(sha)).parents.map(p => p.sha)));
    const base = git.commitAt(lookup(common.find(sha => !older.has(sha))));
    const original = new Map(lookup(git.trees.get(base.tree.sha)).map(e => [e.path, e]));
    const changed = new Map<string, string>();
    for (const entry of lookup(git.trees.get(head.tree.sha))) {
      const old = original.get(entry.path);
      if (old?.sha !== entry.sha || old.mode !== entry.mode) {
        changed.set(entry.path, lookup(git.blobs.get(entry.sha)).toString("utf8"));
      }
      original.delete(entry.path);
    }
    return {
      number, head: pull.head, headSha: head.sha, base: pull.base, body: pull.body,
      files: Object.fromEntries(changed), deletedFiles: [...original.keys()],
    };
  }

  const handler: RequestListener = async (request, reply) => {
    function json(data: unknown, status = 200) {
      reply.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    }
    try {
      const method = request.method;
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      const path = decodeURIComponent(url.pathname);
      const query = url.searchParams;
      const body = await readBody(request);
      if (method === "GET") {
        if (path === "/app/installations") return json([{ id: installationId }]);
        if (path === "/installation/repositories") return json({ total_count: 1, repositories: [repository] });
        if (path === "/repositories/" + repositoryId || path === "/repos/" + repo) return json(repository);
      }
      if (method === "POST" && path === "/app/installations/" + installationId + "/access_tokens") {
        return json({ token: "ExampleInstallation266", expires_at: new Date(Date.now() + 3600000).toISOString() }, 201);
      }
      const prefix = "/repos/" + repo + "/";
      if (!path.startsWith(prefix)) throw new HttpError(404, "找不到驗收儲存庫");
      const route = path.slice(prefix.length);
      const [resource, ...parts] = route.split("/");
      const id = parts.join("/");

      if (method === "GET" && route === "installation") return json({ id: installationId });
      if (method === "GET" && resource === "branches") {
        const branch = (name: string) => ({ name, commit: { sha: lookup(git.refs.get(name)) } });
        if (id) return json(branch(id));
        const perPage = Number(query.get("per_page") ?? 30);
        const start = (Number(query.get("page") ?? 1) - 1) * perPage;
        return json([...git.refs.keys()].slice(start, start + perPage).map(branch));
      }
      if (method === "GET" && resource === "tarball") {
        const commit = git.commitAt(id || defaultBranch);
        const bytes = await tarball(commit.sha, lookup(git.trees.get(commit.tree.sha)), git.blobs);
        reply.writeHead(200, { "content-type": "application/gzip" }).end(bytes);
        return;
      }
      if (method === "GET" && resource === "contents") {
        const commit = git.commitAt(query.get("ref") ?? defaultBranch);
        const entry = lookup(git.trees.get(commit.tree.sha)?.find(e => e.path === id));
        const bytes = lookup(git.blobs.get(entry.sha));
        return json({ ...entry, type: "file", name: parts.at(-1), size: bytes.length, encoding: "base64", content: bytes.toString("base64") });
      }
      if (method === "GET" && resource === "compare") {
        const [base, head] = id.split("...");
        if (!base || !head) throw new HttpError(404, "缺少比較版本");
        const before = git.ancestors(git.commitAt(base).sha);
        const after = git.ancestors(git.commitAt(head).sha);
        const ahead = [...after].filter(sha => !before.has(sha)).length;
        const behind = [...before].filter(sha => !after.has(sha)).length;
        return json({ ahead_by: ahead, behind_by: behind, html_url: webUrl + "/compare/" + id });
      }

      if (resource === "git") {
        const [kind, ...tail] = parts;
        const key = tail.join("/");
        if (kind === "blobs") {
          if (method === "GET" && key) {
            const bytes = lookup(git.blobs.get(key));
            return json({ sha: key, encoding: "base64", content: bytes.toString("base64"), size: bytes.length });
          }
          if (method === "POST" && !key) {
            const data = z.object({ content: z.string(), encoding: z.enum(["base64", "utf-8"]) }).parse(body);
            return json({ sha: git.writeBlob(Buffer.from(data.content, data.encoding)) }, 201);
          }
        }
        if (kind === "trees") {
          if (method === "GET" && key) {
            const sha = git.trees.has(key) ? key : git.commitAt(key).tree.sha;
            const tree = lookup(git.trees.get(sha)).map(e => ({ ...e, size: lookup(git.blobs.get(e.sha)).length }));
            return json({ sha, tree, truncated: false });
          }
          if (method === "POST" && !key) {
            const data = z.object({ base_tree: z.string().optional(), tree: z.array(treeChange) }).parse(body);
            const base = data.base_tree === undefined ? [] : lookup(git.trees.get(data.base_tree));
            const entries = new Map(base.map(e => [e.path, e]));
            for (const entry of data.tree) {
              if (entry.sha === null) {
                requireValid(entries.delete(entry.path), "待刪除檔案不存在");
              } else {
                requireValid(git.blobs.has(entry.sha), "找不到 blob");
                entries.set(entry.path, { ...entry, sha: entry.sha });
              }
            }
            const sha = git.writeTree([...entries.values()]);
            return json({ sha, tree: git.trees.get(sha) }, 201);
          }
        }
        if (kind === "commits") {
          if (method === "GET" && key) return json(lookup(git.commits.get(key)));
          if (method === "POST" && !key) {
            const data = z.object({ tree: z.string(), parents: z.array(z.string()), message: z.string() }).parse(body);
            requireValid(git.trees.has(data.tree) && data.parents.every(p => git.commits.has(p)), "找不到提交的樹或父提交");
            return json(git.writeCommit(data.tree, data.parents, data.message), 201);
          }
        }
        if (method === "POST" && id === "refs") {
          const { ref, sha } = z.object({ ref: z.string().startsWith("refs/heads/"), sha: z.string() }).parse(body);
          const name = ref.slice("refs/heads/".length);
          requireValid(validTargetBranch(name) && !git.refs.has(name) && git.commits.has(sha), "無法建立分支參照");
          git.refs.set(name, sha);
          return json(refView(name), 201);
        }
        if (key.startsWith("heads/")) {
          const branch = key.slice("heads/".length);
          if (method === "GET" && kind === "ref") return json(refView(branch));
          if (method === "PATCH" && kind === "refs") {
            const data = z.object({ sha: z.string(), force: z.boolean().default(false) }).parse(body);
            const old = lookup(git.refs.get(branch));
            requireValid(git.commits.has(data.sha), "找不到目標提交");
            requireValid(data.force || git.ancestors(data.sha).has(old), "分支無法快轉");
            git.refs.set(branch, data.sha);
            return json(refView(branch));
          }
        }
      }

      const matchesState = (item: Issue) =>
        query.get("state") === "all" || item.state === (query.get("state") ?? "open");
      if (resource === "issues") {
        if (method === "GET" && !id) {
          const pulls = [...visiblePulls().values()].map(p => ({ ...pullView(p), pull_request: { html_url: p.html_url } }));
          return json([...state.issues.values(), ...pulls].filter(matchesState));
        }
        if (method === "POST" && !id) {
          const data = newIssue.parse(body);
          const number = nextNumber++;
          const issue: Issue = { ...data, number, state: "open", html_url: webUrl + "/issues/" + number };
          state.issues.set(number, issue);
          return json(issue, 201);
        }
        const number = Number(parts[0]);
        if (parts.length === 2 && parts[1] === "comments") {
          lookup(state.issues.get(number) ?? visiblePulls().get(number));
          const comments = state.comments.get(number) ?? [];
          if (method === "GET") return json(comments);
          if (method === "POST") {
            const data = z.object({ body: z.string() }).parse(body);
            const comment = { id: nextComment++, body: data.body };
            state.comments.set(number, [...comments, comment]);
            return json(comment, 201);
          }
        }
        if (parts.length === 1) {
          const issue = lookup(state.issues.get(number));
          if (method === "GET") return json(issue);
          if (method === "PATCH") return json(Object.assign(issue, issueFields.partial().parse(body)));
        }
      }
      if (resource === "pulls") {
        if (method === "GET" && !id) {
          const head = query.get("head");
          const base = query.get("base");
          const owner = repo.split("/")[0];
          return json([...visiblePulls().values()].filter(p => matchesState(p) &&
            (!head || head === owner + ":" + p.head) && (!base || base === p.base)).map(pullView));
        }
        if (method === "POST" && !id) {
          const data = newPull.parse(body);
          if (state.omitPullRequest) throw new HttpError(503, "驗收注入：未建立 PR");
          requireValid(git.refs.has(data.head) && git.refs.has(data.base) && data.head !== data.base, "PR 分支無效");
          requireValid(![...state.pulls.values()].some(p => p.state === "open" && p.head === data.head && p.base === data.base), "PR 已存在");
          const number = nextNumber++;
          const pull: Pull = { ...data, number, state: "open", merged: false, html_url: webUrl + "/pull/" + number };
          state.pulls.set(number, pull);
          return json(pullView(pull), 201);
        }
        if (id && (method === "GET" || method === "PATCH")) {
          const pull = lookup(visiblePulls().get(Number(id)));
          if (method === "PATCH") Object.assign(pull, issueFields.partial().parse(body));
          return json(pullView(pull));
        }
      }
      throw new HttpError(404, "未提供這個驗收路由");
    } catch (error) {
      if (error instanceof HttpError) return json({ message: error.message }, error.status);
      if (error instanceof z.ZodError) return json({ message: "驗收請求欄位無效" }, 422);
      return json({ message: "驗收替身處理失敗" }, 500);
    }
  };
  return { handler, fixture, state, readPr };
}
