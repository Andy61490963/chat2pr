import type { Page } from "@playwright/test";
import type { Detail, State } from "../src/app/shared";
import type { Group, Project, Task } from "../shared/types";
import { endedStatuses } from "../shared/types";
import {
  checkEnvironmentLimits,
  defaultCheckEnvironmentPolicy,
} from "../shared/check-environment";
import { defaultDiskSettings, type DiskReport } from "../shared/docker-disk";
import type { ChatPage } from "../shared/chat";
import { discordServiceText } from "../shared/status-glossary";
import type { ActivityEvent } from "../shared/activity-groups";

const timestamp = "2026-01-01T00:00:00Z";

export const systemSnapshot = {
  checkedAt: timestamp,
  requiredWorkerRev: "demo",
  runner: { state: "ok" },
  services: [
    {
      name: "line-agentflow-app-1",
      role: "看板與排程服務",
      image: "demo-app:local",
      state: "running",
      status: "Up (healthy)",
      created: timestamp,
    },
  ],
  jobs: [],
  images: [
    {
      tag: "line-agentflow-worker:local",
      rev: "demo",
      current: true,
      sizeMb: 2048,
      created: timestamp,
    },
    {
      tag: "line-agentflow-worker:demo-old",
      rev: "demo-old",
      current: false,
      sizeMb: 2048,
      created: timestamp,
    },
    {
      tag: "line-agentflow-worker:demo-unused",
      rev: null,
      current: false,
      sizeMb: 1024,
      created: timestamp,
    },
  ],
  volumes: { jobs: 0, sourceCaches: 0 },
};

export const diskReport: DiskReport = {
  checkedAt: timestamp,
  instance: "demo",
  settings: defaultDiskSettings,
  usage: [
    {
      kind: "images",
      label: "映像",
      total: 3,
      active: 2,
      size: 5 * 1024 ** 3,
      reclaimable: 1024 ** 3,
    },
  ],
  spaces: [
    {
      label: "範例磁碟",
      freeBytes: 80 * 1024 ** 3,
      totalBytes: 100 * 1024 ** 3,
    },
  ],
  level: "ok",
  freePercent: 80,
  paused: false,
  owners: [],
  candidates: [],
  protected: [],
  nextCleanupAt: null,
  lastCleanup: null,
};

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
  platform: "line",
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

export const discordGroup: Group = {
  ...group,
  id: "discord:100000000000000001",
  platform: "discord",
  name: "範例伺服器／#需求",
  reply_mode: "off",
};

export const discordHealth: State["health"] = [
  {
    name: "discord",
    ok: true,
    detail: discordServiceText.connected,
    checked_at: timestamp,
  },
];

export const statusProjects: Project[] = [
  { ...project, name: "示範專案", image: "line-agentflow-worker:demo-old" },
];

export const exhaustedPushHealth: State["health"] = [
  {
    name: "notifications",
    ok: false,
    detail: "Error: LINE 通知失敗（429）",
    checked_at: timestamp,
  },
  {
    name: "line_quota",
    ok: false,
    detail: "LINE 本月推播額度已用完（本月已用 200／上限 200 則）",
    checked_at: timestamp,
  },
];

export const statusChat: ChatPage = {
  messages: ([
    ["chat", "小林今天會整理測試資料。"],
    ["processed", "下週的檢查方式還在討論。"],
    ["pending", "請確認示範服務是否正常。"],
  ] as const).map(([routing, text]) => ({
    id: `example-${routing}`,
    sender: "小林",
    type: "text",
    text,
    received_at: timestamp,
    quoted_id: null,
    quoted_text: null,
    quoted_sender: null,
    quoted_bot_id: null,
    revoked: false,
    expired: false,
    has_image: false,
    image_state: null,
    routing,
    tasks: [],
  })),
  bot_messages: [],
  next: null,
};

export const task: Task = {
  id: "11111111-1111-4111-8111-111111111111",
  project_id: project.id,
  group_id: group.id,
  title: "確認範例畫面",
  summary: "確認範例畫面可以正常開啟。",
  acceptance: ["能開啟範例畫面"],
  status: "awaiting_approval",
  end_summary: null,
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

const endedAt = "2026-11-20T02:30:00.000Z";
export const rejectedTask: Task = {
  ...task,
  id: "16400000-0000-4000-8000-000000000001",
  title: "整理範例操作手冊",
  status: "rejected",
  updated_at: endedAt,
  end_summary: { kind: "reject", actor: "小林", at: endedAt, reason: null, station: null },
};
export const cancelledTask: Task = {
  ...task,
  id: "16400000-0000-4000-8000-000000000002",
  title: "調整範例設備報表",
  mode: "change",
  status: "cancelled",
  updated_at: endedAt,
  risk_reasons: [
    "共用設備帳密需要人工審核。；設備主檔寫入需要人工審核。",
    "共用設備帳密需要人工審核",
  ],
  end_summary: {
    kind: "cancel",
    actor: "小陳",
    at: endedAt,
    reason: "範例報表已由小林整理",
    station: null,
  },
};
export const closedPrTask: Task = {
  ...task,
  id: "16400000-0000-4000-8000-000000000003",
  title: "更新範例出貨清單",
  mode: "change",
  status: "closed",
  pr_number: 12,
  updated_at: endedAt,
  end_summary: { kind: "closed", actor: null, at: endedAt, reason: null, station: "pr" },
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

export const activityTask: Task = {
  ...task,
  title: "重新確認示範機台是否連得上",
  mode: "query",
  status: "answered",
};

const activityTaskFields = {
  task_id: activityTask.id,
  task_title: activityTask.title,
  task_mode: activityTask.mode,
};
export const unchangedCleanup =
  "Docker 定期清理：刪除 0 個舊映像標籤；0 個懸空映像；建置快取 0.0 GB；映像共釋放 0.0 GB";
export const changedCleanup = unchangedCleanup.replace("刪除 0", "刪除 1");
export const repeatedActivity = "管理者 小林 更新示範專案的設定";
export const recentActivity: ActivityEvent[] = [
  {
    ...activityTaskFields,
    id: 6,
    kind: "answered",
    detail: `查詢已回覆：${activityTask.title}`,
    created_at: "2026-01-10T08:30:00Z",
  },
  {
    id: 5,
    task_id: null,
    kind: "settings",
    detail: repeatedActivity,
    created_at: "2026-01-10T08:25:00Z",
  },
  {
    id: 4,
    task_id: null,
    kind: "docker_cleanup",
    detail: changedCleanup,
    created_at: "2026-01-10T08:24:00Z",
  },
  {
    id: 3,
    task_id: null,
    kind: "docker_cleanup",
    detail: unchangedCleanup,
    created_at: "2026-01-10T08:23:00Z",
  },
  {
    ...activityTaskFields,
    id: 2,
    kind: "attempt",
    detail: "開始調查",
    created_at: "2026-01-10T08:20:00Z",
  },
  {
    id: 1,
    task_id: null,
    kind: "settings",
    detail: repeatedActivity,
    created_at: "2026-01-10T08:15:00Z",
  },
  {
    ...activityTaskFields,
    id: 0,
    kind: "triage",
    detail: "需求明確且通過風險規則，已自動排程",
    created_at: "2026-01-10T08:10:00Z",
  },
];

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
    [`/api/groups/${encodeURIComponent(discordGroup.id)}/messages`]: statusChat,
    [`/api/projects/${project.id}/ssh-hosts`]: [],
    [`/api/projects/${project.id}/database`]: {
      connection: null,
      snapshot: null,
    },
    "/api/checks": [],
    "/api/members": [],
    "/api/system": systemSnapshot,
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
    "/api/system/disk": diskReport,
    ...options.routes,
  };

  // 測試自行發送串流事件，避免假的串流結束後反覆重連、顯示離線橫幅。
  await page.addInitScript(() => {
    Object.defineProperty(window, "EventSource", {
      value: class extends EventTarget {
        static CLOSED = 2;
        readyState = 0;
        private readonly relay = (event: Event) => {
          const type = (event as CustomEvent<string>).detail;
          this.readyState = type === "error" ? 0 : 1;
          this.dispatchEvent(new Event(type));
        };
        constructor() {
          super();
          window.addEventListener("dashboard-event", this.relay);
        }
        close() {
          window.removeEventListener("dashboard-event", this.relay);
          this.readyState = 2;
        }
      },
    });
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
    // 任務頁「已結束／全部」分批讀取：預設用狀態快照裡的任務回應，個別測試可自行覆寫。
    if (request.method() === "GET" && pathname === "/api/tasks") {
      const closed =
        new URL(request.url()).searchParams.get("filter") === "closed";
      const tasks = ((routes["/api/state"] as { tasks?: Task[] }).tasks ?? [])
        .filter((entry) => !closed || endedStatuses.includes(entry.status))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return route.fulfill({ json: { tasks, next: null } });
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

export async function emitDashboardEvent(
  page: Page,
  type: "connected" | "error" | "update",
) {
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent("dashboard-event", { detail }));
  }, type);
}
