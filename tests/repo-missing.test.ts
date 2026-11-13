import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHmac } from "node:crypto";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({
    lineSecret: "fictional-secret",
    githubWebhookSecret: "fictional-github",
  }),
}));
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { GitHub } from "../server/github.js";
import { syncOpenPullRequests } from "../server/pr-sync.js";
import { syncProjectRepos } from "../server/repo-missing.js";
import type { Project } from "../shared/types.js";

beforeEach(reset);
afterEach(() => vi.restoreAllMocks());
afterAll(() => db.close());

// GitHub 的回答：找不到、還在原位，或在另一個位置。
const gone = { locateRepo: async () => null };
const here = {
  locateRepo: async (repo: string) => ({ id: 1, full_name: repo }),
};
const at = (full_name: string, id = 1) => ({
  locateRepo: async () => ({ id, full_name }),
});
const locate = (found: { id: number; full_name: string } | null) =>
  vi.spyOn(GitHub.prototype, "locateRepo").mockResolvedValue(found);

const project = (id: string) =>
  db.one<Project>("SELECT * FROM projects WHERE id=$1", [id]);
const task = (
  projectId: string,
  status: string,
  key: string,
  pr: number | null = null,
) =>
  db.one<{ id: string }>(
    "INSERT INTO tasks(project_id,group_id,title,summary,status,pr_number,pr_url,issue_url,dedupe_key) VALUES($1,'group-a','任務','內容',$2,$3,$4,$5,$6) RETURNING id",
    [
      projectId,
      status,
      pr,
      pr && `https://github.com/test/repo/pull/${pr}`,
      pr && `https://github.com/test/repo/issues/${pr + 100}`,
      key,
    ],
  );
const statusOf = (id: string) =>
  db.one<{
    status: string;
    project_id: string | null;
    last_error: string | null;
    pr_url: string | null;
    issue_url: string | null;
  }>(
    "SELECT status,project_id,last_error,pr_url,issue_url FROM tasks WHERE id=$1",
    [id],
  );
const notices = (kind = "repo_missing") =>
  db.query<{ text: string; task_id: string | null }>(
    "SELECT text,task_id FROM notifications WHERE kind=$1 ORDER BY created_at",
    [kind],
  );
const bindings = () => db.query("SELECT 1 FROM group_projects");
const webhook = (app: Awaited<ReturnType<typeof buildApp>>) => {
  let n = 0;
  return (event: string, payload: object) => {
    const body = JSON.stringify(payload);
    return app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": `d${++n}`,
        "x-github-event": event,
        "x-hub-signature-256":
          "sha256=" +
          createHmac("sha256", "fictional-github").update(body).digest("hex"),
      },
    });
  };
};

describe("儲存庫找不到時先停用並記下原狀", () => {
  it("定期檢查找不到：停用專案、暫時解除綁定、還沒做的任務交回人工、待合併的保留，且只提醒一次", async () => {
    const id = await fixture();
    const queued = await task(id, "queued", "q"),
      ready = await task(id, "ready", "r", 7),
      merged = await task(id, "merged", "m", 6);
    await syncProjectRepos(db, gone);
    await syncProjectRepos(db, gone);

    const p = await project(id);
    expect(p.enabled).toBe(false);
    expect(p.validated_at).toBeNull();
    expect(p.repo_missing_at).not.toBeNull();
    expect(p.validation_error).toContain("找不到");
    expect(p.repo_missing_state).toMatchObject({
      enabled: true,
      groups: ["group-a"],
      tasks: [queued.id],
      closed: [],
    });
    expect(await bindings()).toHaveLength(0);

    const q = await statusOf(queued.id);
    expect(q.status).toBe("awaiting_approval");
    expect(q.project_id).toBeNull();
    expect(q.last_error).toContain("儲存庫找不到了");
    // 不確定是不是刪除，PR 可能還在：待合併的任務不結束。
    const r = await statusOf(ready.id);
    expect(r.status).toBe("ready");
    expect(r.project_id).toBe(id);
    const m = await statusOf(merged.id);
    expect(m.status).toBe("merged");
    expect(m.project_id).toBe(id);

    const sent = await notices();
    expect(sent).toHaveLength(1);
    expect(sent[0].task_id).toBeNull();
    expect(sent[0].text).toContain("測試專案");
    expect(sent[0].text).toContain("test/repo");
    expect(sent[0].text).toContain("「測試群組」");
    expect(sent[0].text).toContain("1 個待合併的任務先保留");
    expect(sent[0].text).toContain("搬家");
  });

  it("GitHub 暫時查不到不算找不到", async () => {
    const id = await fixture();
    await syncProjectRepos(db, {
      locateRepo: async () => {
        throw Object.assign(new Error("server error"), { status: 502 });
      },
    });
    expect((await project(id)).repo_missing_at).toBeNull();
    expect(await bindings()).toHaveLength(1);
    expect(await notices()).toHaveLength(0);
  });

  it("剛建立、還沒驗證也沒綁群組的專案不會被提醒", async () => {
    await db.query(
      "INSERT INTO projects(name,repo) VALUES('新專案','new/repo')",
    );
    await syncProjectRepos(db, gone);
    expect(await notices()).toHaveLength(0);
  });

  it("找不到的期間不查 PR 狀態，接回後才繼續同步", async () => {
    const id = await fixture();
    await task(id, "ready", "r", 7);
    const pullState = vi.fn(async () => ({
      state: "open" as const,
      merged: false,
    }));
    await syncProjectRepos(db, gone);
    await syncOpenPullRequests(db, { pullState });
    expect(pullState).not.toHaveBeenCalled();
    await syncProjectRepos(db, here);
    await syncOpenPullRequests(db, { pullState });
    expect(pullState).toHaveBeenCalledTimes(1);
  });
});

describe("儲存庫接回後照原狀復原", () => {
  it("又找得到：重新啟用、綁回群組、任務掛回專案等管理者重新核准", async () => {
    const id = await fixture();
    const queued = await task(id, "queued", "q");
    await syncProjectRepos(db, gone);
    await syncProjectRepos(db, here);
    await syncProjectRepos(db, here);

    const p = await project(id);
    expect(p.repo_missing_at).toBeNull();
    expect(p.repo_missing_state).toBeNull();
    expect(p.enabled).toBe(true);
    expect(p.validated_at).not.toBeNull();
    expect(p.validation_error).toBeNull();
    expect(Number(p.repo_id)).toBe(1);
    expect(await bindings()).toHaveLength(1);
    const q = await statusOf(queued.id);
    expect(q.status).toBe("awaiting_approval");
    expect(q.project_id).toBe(id);
    expect(q.last_error).toBeNull();

    const back = await notices("repo_found");
    expect(back).toHaveLength(1);
    expect(back[0].text).toContain("已自動接回並重新啟用");
    expect(back[0].text).toContain("綁回群組「測試群組」");
    expect(back[0].text).toContain("1 個任務已掛回這個專案");
  });

  it("搬到已安裝 App 的新位置：直接跟過去，什麼都不停用，PR 與 Issue 連結一起換", async () => {
    const id = await fixture();
    const ready = await task(id, "ready", "r", 7);
    // 第一次檢查記下固定編號，之後就用編號找。
    await syncProjectRepos(db, here);
    const locateRepo = vi.fn(async () => ({
      id: 1,
      full_name: "new-org/renamed",
    }));
    await syncProjectRepos(db, { locateRepo });
    await syncProjectRepos(db, { locateRepo });
    expect(locateRepo).toHaveBeenNthCalledWith(1, "test/repo", 1);
    expect(locateRepo).toHaveBeenNthCalledWith(2, "new-org/renamed", 1);

    const p = await project(id);
    expect(p.repo).toBe("new-org/renamed");
    expect(p.enabled).toBe(true);
    expect(p.validated_at).not.toBeNull();
    expect(p.repo_missing_at).toBeNull();
    expect(await bindings()).toHaveLength(1);
    const r = await statusOf(ready.id);
    expect(r.status).toBe("ready");
    expect(r.pr_url).toBe("https://github.com/new-org/renamed/pull/7");
    expect(r.issue_url).toBe("https://github.com/new-org/renamed/issues/107");

    expect(await notices()).toHaveLength(0);
    const moved = await notices("repo_found");
    expect(moved).toHaveLength(1);
    expect(moved[0].text).toContain("test/repo");
    expect(moved[0].text).toContain("new-org/renamed");
  });

  it("找不到之後才在新位置出現：改用新路徑並復原", async () => {
    const id = await fixture();
    await syncProjectRepos(db, gone);
    await syncProjectRepos(db, at("new-org/repo", 9));
    const p = await project(id);
    expect(p.repo).toBe("new-org/repo");
    expect(Number(p.repo_id)).toBe(9);
    expect(p.enabled).toBe(true);
    expect(await bindings()).toHaveLength(1);
    expect((await notices("repo_found"))[0].text).toContain(
      "已從 test/repo 搬到 new-org/repo",
    );
  });

  it("找不到的期間改過設定：接回並綁回群組，但要重新驗證才啟用", async () => {
    const id = await fixture();
    await syncProjectRepos(db, gone);
    await db.query("UPDATE projects SET config_version=config_version+1");
    await syncProjectRepos(db, here);
    const p = await project(id);
    expect(p.repo_missing_at).toBeNull();
    expect(p.enabled).toBe(false);
    expect(p.validated_at).toBeNull();
    expect(p.validation_error).toContain("改過設定");
    expect(await bindings()).toHaveLength(1);
  });

  it("舊版標記沒有記下原狀：改用新路徑，但要重新驗證並重新勾選群組", async () => {
    const id = await fixture();
    await db.query(
      "UPDATE projects SET repo_missing_at=now(),enabled=false,validated_at=NULL",
    );
    await db.query("DELETE FROM group_projects");
    await syncProjectRepos(db, at("new-org/repo", 9));
    const p = await project(id);
    expect(p.repo).toBe("new-org/repo");
    expect(p.repo_missing_at).toBeNull();
    expect(p.enabled).toBe(false);
    expect(p.validated_at).toBeNull();
    expect(p.validation_error).toContain("重新驗證");
    expect(await bindings()).toHaveLength(0);
    expect((await notices("repo_found"))[0].text).toContain("重新勾選");
  });

  it("新位置已經有另一個專案在用：不合併，標成找不到交給管理者", async () => {
    const id = await fixture();
    const other = await db.one<{ id: string }>(
      "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('第二個','other/repo',true,now()) RETURNING id",
    );
    await syncProjectRepos(db, {
      locateRepo: async (repo: string) =>
        repo === "test/repo"
          ? { id: 1, full_name: "other/repo" }
          : { id: 2, full_name: repo },
    });
    expect((await project(id)).repo).toBe("test/repo");
    expect((await project(id)).repo_missing_at).not.toBeNull();
    expect((await project(other.id)).repo_missing_at).toBeNull();
    expect((await project(other.id)).enabled).toBe(true);
  });
});

describe("GitHub Webhook", () => {
  it("儲存庫刪除或 App 被移出時立即處理，其他 deleted 事件不受影響", async () => {
    const id = await fixture(),
      app = await buildApp(db),
      send = webhook(app);
    const ready = await task(id, "ready", "r", 7);
    // 刪除標籤、分支保護等事件也帶 action=deleted 與 repository。
    await send("label", {
      action: "deleted",
      repository: { full_name: "test/repo" },
    });
    expect((await project(id)).repo_missing_at).toBeNull();

    // GitHub 的儲存庫名稱不分大小寫。
    await send("repository", {
      action: "deleted",
      repository: { full_name: "Test/Repo" },
    });
    expect((await project(id)).repo_missing_at).not.toBeNull();
    expect(await bindings()).toHaveLength(0);
    // 確定刪除，PR 也不在了。
    expect((await statusOf(ready.id)).status).toBe("closed");
    expect((await notices())[0].text).toContain("已在 GitHub 上刪除");
    expect((await notices())[0].text).toContain("1 個待合併的任務已結束");

    // 這裡的憑證是虛構的，問不到 GitHub，就照失去存取權處理。
    const other = await db.one<{ id: string }>(
      "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('第二個','test/other',true,now()) RETURNING id",
    );
    await send("installation_repositories", {
      action: "removed",
      repositories_removed: [{ id: 2, full_name: "test/other" }],
    });
    expect((await project(other.id)).repo_missing_at).not.toBeNull();
    expect(await notices()).toHaveLength(2);

    // 刪除的儲存庫在 GitHub 上還原後，結束的待合併任務一併恢復。
    await syncProjectRepos(db, {
      locateRepo: async (repo: string) =>
        repo === "test/repo" ? { id: 1, full_name: repo } : null,
    });
    expect((await project(id)).enabled).toBe(true);
    expect((await statusOf(ready.id)).status).toBe("ready");
    await app.close();
  });

  it("轉移與改名：依 GitHub 給的新位置跟過去，專案照常運作", async () => {
    const id = await fixture(),
      app = await buildApp(db),
      send = webhook(app);
    await send("repository", {
      action: "transferred",
      repository: { id: 55, full_name: "new-org/repo" },
      changes: { owner: { from: { organization: { login: "Test" } } } },
    });
    let p = await project(id);
    expect(p.repo).toBe("new-org/repo");
    expect(Number(p.repo_id)).toBe(55);
    expect(p.enabled).toBe(true);
    expect(await bindings()).toHaveLength(1);

    // 記下編號之後，改名靠編號對應。
    await send("repository", {
      action: "renamed",
      repository: { id: 55, full_name: "new-org/renamed" },
      changes: { repository: { name: { from: "something-else" } } },
    });
    p = await project(id);
    expect(p.repo).toBe("new-org/renamed");
    expect(p.repo_missing_at).toBeNull();
    expect(await notices()).toHaveLength(0);
    expect(await notices("repo_found")).toHaveLength(2);
    await app.close();
  });

  it("App 被移出原帳號但儲存庫在另一個已安裝的位置：跟過去，不停用", async () => {
    const id = await fixture(),
      app = await buildApp(db),
      send = webhook(app);
    const locateRepo = locate({ id: 1, full_name: "new-org/repo" });
    await send("installation", {
      action: "deleted",
      repositories: [{ id: 1, full_name: "test/repo" }],
    });
    expect(locateRepo).toHaveBeenCalledWith("test/repo", 1);
    const p = await project(id);
    expect(p.repo).toBe("new-org/repo");
    expect(p.enabled).toBe(true);
    expect(p.repo_missing_at).toBeNull();
    expect(await bindings()).toHaveLength(1);
    expect(await notices()).toHaveLength(0);
    await app.close();
  });

  it("App 裝到新的帳號或儲存庫時，馬上再找一次找不到的專案；平常的檢查可以先跳過它們", async () => {
    const id = await fixture(),
      app = await buildApp(db),
      send = webhook(app);
    await syncProjectRepos(db, gone);
    // 每 10 分鐘那次只查還在的專案，不會為了找不到的專案去問每個安裝。
    const locateRepo = locate({ id: 1, full_name: "new-org/repo" });
    await syncProjectRepos(db, GitHub.prototype, "present");
    expect(locateRepo).not.toHaveBeenCalled();
    expect((await project(id)).repo_missing_at).not.toBeNull();
    // 其他安裝事件（例如暫停）不會觸發。
    await send("installation", { action: "suspend" });
    expect(locateRepo).not.toHaveBeenCalled();
    await send("installation_repositories", {
      action: "added",
      repositories_added: [{ id: 1, full_name: "new-org/repo" }],
    });
    const p = await project(id);
    expect(p.repo).toBe("new-org/repo");
    expect(p.enabled).toBe(true);
    expect(p.repo_missing_at).toBeNull();
    expect(await bindings()).toHaveLength(1);
    await app.close();
  });
});

describe("管理 API", () => {
  it("找不到儲存庫的專案不能綁定群組；刪除專案時保留的待合併任務一併結束、歷史任務留著", async () => {
    const id = await fixture(),
      headers = await session(),
      app = await buildApp(db);
    const done = await task(id, "merged", "done", 3),
      ready = await task(id, "ready", "r", 7);
    const remove = () =>
      app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers });
    expect((await remove()).statusCode).toBe(409);

    await syncProjectRepos(db, gone);
    const state = (await app.inject({ url: "/api/state", headers })).json();
    expect(state.projects[0].repo_missing_at).toBeTruthy();
    expect(state.projects[0].repo_missing_state.groups).toEqual(["group-a"]);
    expect(state.groups[0].project_ids).toEqual([]);
    expect(state.alerts[0].kind).toBe("repo_missing");

    const bind = await app.inject({
      method: "PUT",
      url: "/api/groups/group-a",
      headers,
      payload: { ...state.groups[0], project_ids: [id] },
    });
    expect(bind.statusCode).toBe(409);
    expect(bind.json().error).toContain("儲存庫目前找不到");

    expect((await remove()).statusCode).toBe(200);
    expect(await db.query("SELECT 1 FROM projects")).toHaveLength(0);
    const kept = await statusOf(done.id);
    expect(kept.status).toBe("merged");
    expect(kept.project_id).toBeNull();
    expect((await statusOf(ready.id)).status).toBe("closed");
    await app.close();
  });

  it("找不到儲存庫的專案可以改選另一個儲存庫：綁定與任務掛回，環境要重新驗證", async () => {
    const id = await fixture(),
      headers = await session(),
      app = await buildApp(db);
    const queued = await task(id, "queued", "q"),
      ready = await task(id, "ready", "r", 7);
    const put = async (repo: string) => {
      const p = await project(id);
      return app.inject({
        method: "PUT",
        url: `/api/projects/${id}`,
        headers,
        payload: {
          name: p.name,
          repo,
          description: p.description,
          base_branch: p.base_branch,
          image: p.image,
          install_command: p.install_command,
          test_command: p.test_command,
          sensitive_paths: p.sensitive_paths,
          index_paths: p.index_paths,
          enabled: false,
        },
      });
    };
    // 儲存庫還在的專案不能換。
    const refused = await put("other/place");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain("請新增專案");

    await syncProjectRepos(db, here);
    await syncProjectRepos(db, gone);
    const version = (await project(id)).config_version;

    locate(null);
    expect((await put("other/place")).statusCode).toBe(403);

    await db.query(
      "INSERT INTO projects(name,repo) VALUES('第二個','taken/repo')",
    );
    locate({ id: 5, full_name: "taken/repo" });
    const taken = await put("taken/repo");
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toContain("另一個專案");

    locate({ id: 77, full_name: "other/place" });
    const saved = await put("other/place");
    expect(saved.statusCode).toBe(200);
    expect(saved.json().repo).toBe("other/place");
    const p = await project(id);
    expect(p.repo_missing_at).toBeNull();
    expect(p.repo_missing_state).toBeNull();
    expect(Number(p.repo_id)).toBe(77);
    expect(p.enabled).toBe(false);
    expect(p.validated_at).toBeNull();
    expect(p.config_version).toBe(version + 1);
    expect(await bindings()).toHaveLength(1);
    const q = await statusOf(queued.id);
    expect(q.status).toBe("awaiting_approval");
    expect(q.project_id).toBe(id);
    // 編號不同就是另一個儲存庫，原本的 PR 不在裡面。
    expect((await statusOf(ready.id)).status).toBe("closed");
    await app.close();
  });

  it("沒記到編號的專案改選儲存庫時當成搬家：待合併任務保留，連結換到新位置", async () => {
    const id = await fixture(),
      headers = await session(),
      app = await buildApp(db);
    const ready = await task(id, "ready", "r", 7);
    await syncProjectRepos(db, gone);
    locate({ id: 9, full_name: "new-org/repo" });
    const p = await project(id);
    const saved = await app.inject({
      method: "PUT",
      url: `/api/projects/${id}`,
      headers,
      payload: {
        name: p.name,
        repo: "new-org/repo",
        description: p.description,
        base_branch: p.base_branch,
        image: p.image,
        install_command: p.install_command,
        test_command: p.test_command,
        sensitive_paths: p.sensitive_paths,
        enabled: false,
      },
    });
    expect(saved.statusCode).toBe(200);
    const r = await statusOf(ready.id);
    expect(r.status).toBe("ready");
    expect(r.pr_url).toBe("https://github.com/new-org/repo/pull/7");
    expect(await bindings()).toHaveLength(1);
    await app.close();
  });

  it("「重新檢查」先找儲存庫的新位置，找到就接回再排程驗證", async () => {
    const id = await fixture(),
      headers = await session(),
      queuedIds: string[] = [],
      app = await buildApp(db, async (projectId) => {
        queuedIds.push(projectId);
      });
    await syncProjectRepos(db, gone);
    const locateRepo = locate({ id: 9, full_name: "new-org/repo" });
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${id}/validate`,
      headers,
    });
    expect(res.statusCode).toBe(202);
    expect(locateRepo).toHaveBeenCalledWith("test/repo", null);
    const p = await project(id);
    expect(p.repo).toBe("new-org/repo");
    expect(p.repo_missing_at).toBeNull();
    expect(await bindings()).toHaveLength(1);
    expect(queuedIds).toEqual([id]);
    await app.close();
  });
});
