import type { Page } from "@playwright/test";
import type { Detail, State } from "../src/app/shared";
import type { Group, Project, Task } from "../shared/types";
import {
  checkEnvironmentLimits,
  defaultCheckEnvironmentPolicy,
} from "../shared/check-environment";
import { defaultDiskSettings } from "../shared/docker-disk";

const timestamp = "2026-01-01T00:00:00Z";

export const project: Project = {
  id: "project-demo",
  name: "測試專案",
  repo: "example/demo",
  description: "測試用專案",
  config_version: 1,
  base_branch: "main",
  image: "demo:local",
  install_command: "",
  test_command: "",
  sensitive_paths: [],
  enabled: true,
  validated_at: timestamp,
  validation_error: null,
  created_at: timestamp,
};

export const group: Group = {
  id: "group-demo",
  name: "測試群組",
  project_ids: [project.id],
  enabled: true,
  trigger_mode: "auto",
  reply_mode: "all",
  trigger_version: 1,
  binding_version: 1,
  triage_failures: 0,
  triage_error: null,
  first_pending_at: null,
  last_pending_at: null,
};

export const task: Task = {
  id: "11111111-1111-4111-8111-111111111111",
  project_id: project.id,
  group_id: group.id,
  title: "確認範例畫面",
  summary: "確認範例畫面可以正常開啟。",
  acceptance: ["能開啟範例畫面"],
  status: "awaiting_approval",
  mode: "query",
  version: 1,
  target_branch: "main",
  risk_reasons: [],
  pending_paths: [],
  approved_paths: [],
  missing: [],
  suggestions: [],
  source_ids: [],
  approved_version: null,
  base_sha: null,
  branch: null,
  issue_number: null,
  issue_url: null,
  pr_number: null,
  pr_url: null,
  parent_id: null,
  last_error: null,
  answer: null,
  created_at: timestamp,
  updated_at: timestamp,
};

export const detail: Detail = {
  task,
  contextEvidence: [],
  images: [],
  sources: [],
  history: [],
  references: [],
  runs: [],
  groupDeliveries: [],
  thread: { before: [], after: [] },
};

export const defaultState: State = {
  settings: {
    rag_enabled: false,
    paused: false,
    triage_paused: false,
    auto_memory: true,
    code_downloads: true,
    group_replies: true,
    container_network: "isolated",
    ai_mode: "subscription",
    daily_runs: 5,
    codex_model: null,
    triage_effort: "low",
    coding_effort: "medium",
    daily_budget: 10,
    task_budget: 2,
    task_minutes: 30,
    triage_model: "demo",
    coding_model: "demo",
    retention_days: 30,
    admin_line_id: null,
  },
  projects: [project],
  groups: [group],
  tasks: [task],
  memories: [],
  knowledge: [],
  health: [],
  activity: [],
  rag: { active: false, completed_at: null, counts: {} },
  usage: { spent: 0, reserved: 0, day: "2026-01-01", runs_today: 0 },
  integrations: {
    line: true,
    openai: true,
    github: true,
    publicUrl: "https://demo.invalid",
  },
  webhooks: {
    line: "https://demo.invalid/line",
    github: "https://demo.invalid/github",
  },
};

export async function mockDashboard(
  page: Page,
  options: {
    state?: Record<string, unknown>;
    routes?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const routes: Record<string, unknown> = {
    "/api/public/status": { githubConfigured: true },
    "/api/me": {
      id: "1",
      login: "demo-admin",
      csrf: "test-only",
      role: "admin",
      owner: true,
    },
    "/api/state": { ...defaultState, ...options.state },
    "/api/codex/account": {
      plan: "demo",
      allowed: true,
      limits: [],
      models: [],
      checkedAt: timestamp,
    },
    [`/api/tasks/${task.id}`]: detail,
    [`/api/groups/${group.id}/messages`]: {
      messages: [],
      bot_messages: [],
      next: null,
    },
    [`/api/projects/${project.id}/ssh-hosts`]: [],
    [`/api/projects/${project.id}/database`]: {
      connection: null,
      snapshot: null,
    },
    "/api/checks": [],
    "/api/members": [],
    "/api/system": {
      checkedAt: timestamp,
      requiredWorkerRev: "demo",
      runner: { state: "ok" },
      services: [],
      jobs: [],
      images: [],
      volumes: { jobs: 0, sourceCaches: 0 },
    },
    "/api/capacity": {
      maxRuns: 2,
      cap: 8,
      defaultRuns: 2,
      memoryFloorMb: 1024,
      memoryResumeMb: 2048,
      suggested: 2,
      host: null,
      hold: null,
      holdKind: null,
      running: [],
      queued: [],
    },
    "/api/metrics/friction": {
      days: 7,
      groupId: null,
      tasks: 0,
      responsesPerTask: null,
      dashboardPerTask: null,
      restated: 0,
      relinked: 0,
      firstReplySeconds: null,
      answerSeconds: null,
      reworkRate: null,
      reworkBase: 0,
    },
    "/api/egress": { domains: [], defaults: [], custom: false, max: 50 },
    "/api/check-environments/settings": {
      ...defaultCheckEnvironmentPolicy,
      defaults: defaultCheckEnvironmentPolicy,
      limits: checkEnvironmentLimits,
    },
    "/api/system/disk/settings": defaultDiskSettings,
    "/api/system/disk": {
      checkedAt: timestamp,
      instance: "demo",
      settings: defaultDiskSettings,
      usage: [],
      spaces: [],
      level: "ok",
      freePercent: 80,
      paused: false,
      owners: [],
      candidates: [],
      protected: [],
      nextCleanupAt: null,
      lastCleanup: null,
    },
    ...options.routes,
  };

  // 固定在已連線、沒有新事件的情境，避免假的串流結束後反覆重連、顯示離線橫幅。
  await page.addInitScript({
    content: "window.EventSource = class extends EventTarget { close() {} };",
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const { hostname, pathname } = new URL(request.url());
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname))
      return route.abort();
    if (!pathname.startsWith("/api/")) return route.continue();
    if (request.method() === "GET" && Object.hasOwn(routes, pathname)) {
      return route.fulfill({ json: routes[pathname] });
    }
    if (request.method() === "POST" && pathname === "/api/alerts/seen") {
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({
      status: 404,
      json: { error: `缺少測試回應：${request.method()} ${pathname}` },
    });
  });
}
