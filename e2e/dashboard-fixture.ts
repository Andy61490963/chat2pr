import type { Page } from "@playwright/test";
import type { listChecks } from "../server/checks";
import type { Member } from "../server/members";
import type { Account, Detail, State } from "../src/app/shared";
import type { DashboardGroup, Project, Task } from "../shared/types";
import { endedStatuses } from "../shared/types";
import {
  hostUnavailablePrefix,
  type CheckRunView,
  type ScheduledCheck,
} from "../shared/checks";
import {
  isMergedInWeek,
  mergedWeekBounds,
  mergedWeekDay,
} from "../shared/task-list";
import type { RunEvent, RunView } from "../shared/observation";
import {
  checkEnvironmentLimits,
  defaultCheckEnvironmentPolicy,
} from "../shared/check-environment";
import { defaultDiskSettings, type DiskReport } from "../shared/docker-disk";
import {
  connectionSecretFields,
  parseConnectionSecrets,
  secretReauthMessage,
  type ConnectionSecretStatus,
} from "../shared/connection-secrets";
import type { ChatPage } from "../shared/chat";
import {
  discordServiceText,
  projectDescriptionPreselection,
} from "../shared/status-glossary";
import type { PickList } from "../shared/pick-list";
import type { StuckTask } from "../shared/stuck-tasks";

const timestamp = "2026-01-01T00:00:00Z";
const bindingVersion = 1;

export const exampleOwner: Member = {
  github_id: "1",
  login: "demo-admin",
  role: "admin",
  added_by: null,
  created_at: "",
  owner: true,
};

export const exampleMember: Member = {
  github_id: "2",
  login: "demo-xiaolin",
  role: "member",
  added_by: exampleOwner.login,
  created_at: timestamp,
};

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

export const group: DashboardGroup = {
  id: "group-demo",
  platform: "line",
  name: "測試群組",
  project_ids: [project.id],
  enabled: true,
  trigger_mode: "auto",
  reply_mode: "all",
  trigger_version: 1,
  binding_version: bindingVersion,
  triage_failures: 0,
  triage_error: null,
  first_pending_at: null,
  last_pending_at: null,
  created_at: timestamp,
  last_message_at: null,
  change_stats: { created: 3, approved: 2, rejected: 1 },
};

export const groupMemory = {
  id: "example-memory",
  group_id: group.id,
  project_id: null,
  content: "設備保養相關問題先查示範手冊。",
  source: "ai",
  source_message_id: null,
  created_at: timestamp,
} satisfies State["memories"][number];

type CheckListEntry = Awaited<ReturnType<typeof listChecks>>[number];

const normalCheck: CheckListEntry = {
  id: "example-check",
  group_id: group.id,
  project_id: project.id,
  name: "示範服務檢查",
  kind: "http",
  target: "https://demo.invalid/health",
  condition: {},
  interval_minutes: 60,
  daily_at: null,
  notify: "group",
  quiet_from: null,
  quiet_to: null,
  alert_text: "範例服務異常",
  recovered_text: "範例服務已恢復",
  rationale: "",
  investigate: false,
  status: "active",
  version: 1,
  approved_version: 1,
  approved_by: "demo-admin",
  created_by: "demo-admin",
  state: "ok",
  consecutive_errors: 0,
  last_run_at: timestamp,
  next_run_at: null,
  last_investigated_at: null,
  source_task_id: null,
  created_at: timestamp,
  updated_at: timestamp,
  last_summary: "範例服務正常",
  missing_connection: false,
  host_unavailable_since: null,
  system_issue: null,
};

const alertCheck = {
  ...normalCheck,
  id: "example-check-alert",
  name: "示範設備檢查",
  state: "alert",
  last_summary: "示範設備的溫度超過門檻",
} satisfies CheckListEntry;

const connectionCheck: CheckListEntry = {
  ...normalCheck,
  id: "example-check-connection",
  name: "示範資料庫檢查",
  kind: "sql",
  target: "SELECT 1 AS reading",
  condition: { column: "reading", op: ">", value: 1 },
  state: "unknown",
  last_run_at: null,
  last_summary: null,
  missing_connection: true,
};

export const blockedCheck: CheckListEntry = {
  ...normalCheck,
  id: "example-check-blocked",
  name: "示範連線檢查",
  host_unavailable_since: timestamp,
  last_summary: `${hostUnavailablePrefix}讀不到主機執行器`,
};

const checkDetail = (check: ScheduledCheck, runs: CheckRunView[] = []) =>
  ({ check, runs });

export const checkAttentionRoutes = {
  "/api/checks": [
    ...Array.from({ length: 20 }, (_, index) => ({
      ...normalCheck,
      id: `example-check-${index + 1}`,
      name: `示範服務檢查 ${index + 1}`,
    })),
    alertCheck,
    connectionCheck,
  ],
  [`/api/checks/${alertCheck.id}`]: checkDetail(alertCheck, [{
    id: 1,
    version: 1,
    started_at: timestamp,
    duration_ms: 20,
    outcome: "alert",
    summary: alertCheck.last_summary,
  }]),
  [`/api/checks/${connectionCheck.id}`]: checkDetail(connectionCheck),
  [`/api/checks/${blockedCheck.id}`]: checkDetail(blockedCheck),
};

export const unnamedLineGroup: DashboardGroup = {
  ...group,
  id: "Cfictional6d7e8f",
  name: "群組 6d7e8f",
  last_message_at: "2026-01-02T05:30:00Z",
};

export const departedLineGroup: DashboardGroup = {
  ...group,
  id: "CfictionalDeparted",
  name: "範例舊群組",
  enabled: false,
  left_at: "2026-01-03T00:00:00Z",
};

export const discordGroup: DashboardGroup = {
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

export const projectSectionsState: Pick<State, "projects" | "groups"> = {
  projects: [
    { ...project, id: "unbound-2", name: "示範專案 2" },
    { ...project, id: "ready-10", name: "範例專案 10" },
    {
      ...project,
      id: "missing",
      name: "待處理專案 10",
      enabled: false,
      validated_at: null,
      repo_missing_at: timestamp,
    },
    {
      ...project,
      id: "ready-2",
      name: "範例專案 2",
      validation_progress: "你的專案正在執行基底測試。",
    },
    {
      ...project,
      id: "failed",
      name: "待處理專案 2",
      enabled: false,
      validated_at: null,
      validation_error: "範例測試沒有通過，請修正後重新驗證。",
    },
    {
      ...project,
      id: "unbound-1",
      name: "示範專案 1",
      validation_progress: "你的專案正在安裝相依套件。",
    },
    { ...project, id: "ready-1", name: "範例專案 1" },
    {
      ...project,
      id: "unverified",
      name: "待處理專案 1",
      enabled: false,
      validated_at: null,
      validation_progress: "你的專案正在排隊等待執行器。",
    },
  ],
  groups: [
    {
      ...group,
      name: "範例群組",
      project_ids: ["ready-1", "ready-2", "ready-10"],
    },
  ],
};

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
    availability: "readable",
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
  discord_thread_id: null,
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

export const stuckTasks = [
  {
    taskId: "26700000-0000-4000-8000-000000000001",
    title: "產生示範專案的月報",
    reason: "同時執行數已滿，正在等待工作結束。",
    actionLabel: "查看執行容量",
    target: "system",
  },
  {
    taskId: task.id,
    title: task.title,
    reason: "已等待人工審核滿一天，尚未決定是否派工。",
    actionLabel: "查看待審需求",
    target: "task",
  },
] satisfies StuckTask[];

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

export const availabilitySources: Detail["sources"] = (
  ["readable", "revoked", "expired"] as const
).map((availability) => ({
  id: `example-source-${availability}`,
  type: "text",
  text: availability === "readable" ? "請整理範例畫面。" : null,
  sender: availability === "readable" ? "小林" : null,
  received_at: timestamp,
  availability,
  revoked: availability !== "readable",
  has_image: false,
}));

export const availabilityChat: ChatPage = {
  messages: availabilitySources.map((m) => ({
    ...m,
    revoked: m.availability === "revoked",
    expired: m.availability === "expired",
    quoted_id: null,
    quoted_text: null,
    quoted_sender: null,
    quoted_bot_id: null,
    image_state: null,
    routing: "chat",
    tasks: [],
  })),
  bot_messages: [],
  next: null,
};

export const completedRun: RunView = {
  id: "demo-run",
  version: task.version,
  status: "done",
  outcome: "ready",
  model: "demo-model",
  started_at: timestamp,
  completed_at: timestamp,
  heartbeat_at: timestamp,
  deadline: timestamp,
  observed: false,
  threads: [],
  phases: [],
  verification_scope: null,
};

export const dashboardSeparatorsTime = "2026-01-01T00:12:00Z";

export async function mockDashboardSeparators(page: Page) {
  const progressTask: Task = {
    ...task,
    id: "11111111-1111-4111-8111-111111111112",
    title: "整理示範報表",
    status: "running",
    run_phase: "code",
    run_started_at: timestamp,
    run_heartbeat_at: dashboardSeparatorsTime,
    run_deadline: "2026-01-01T00:30:00Z",
  };
  const taskDetail: Detail = {
    ...detail,
    task: { ...task, version: 2 },
    contextEvidence: [
      {
        id: "demo-context",
        version: 2,
        phase: "triage-selected",
        mechanism: "direct",
        source_kind: "message",
        source_id: "demo-message",
        observed_at: timestamp,
        valid: false,
      },
    ],
    images: [
      {
        id: "demo-evidence-image",
        mime: "image/png",
        sha256: "a".repeat(64),
        origin: "direct",
        valid: false,
        reason: "來源圖片已到期",
        observation: null,
      },
    ],
    runs: [{ ...completedRun, version: 2 }],
  };
  const runEvents: RunEvent[] = [
    {
      seq: 2,
      at: dashboardSeparatorsTime,
      phase: "code",
      kind: "upstream_retry",
      detail: "上游暫時失敗，已讓 Codex 重試（第 1 次）：upstream_http（HTTP 503）",
    },
    {
      seq: 1,
      at: timestamp,
      phase: "test",
      kind: "command_end",
      exitCode: 1,
    },
  ];
  const exampleProject: Project = {
    ...project,
    context_updated_at: timestamp,
    context_updated_by: "小林",
    setup_mode: "auto",
    setup_plan: {
      branch: project.base_branch,
      sha: "a".repeat(40),
      fingerprint: "demo-plan",
      configVersion: project.config_version,
      install: "",
      test: "",
      verification: "tests",
      explanation: "沿用示範專案的測試設定。",
      evidence: [],
    },
  };
  const knowledge: State["knowledge"][number] = {
    id: "demo-knowledge",
    project_id: project.id,
    group_id: null,
    source: "admin",
    content: "範例日期使用民國年。",
    status: "pending",
    pr_url: null,
    created_at: timestamp,
  };
  const account: Account = {
    plan: "範例方案",
    allowed: true,
    models: [],
    checkedAt: timestamp,
    limits: [
      {
        id: "demo-limit",
        name: null,
        reached: null,
        windows: [
          { usedPercent: 25, minutes: 300, resetsAt: "2026-01-01T05:00:00Z" },
        ],
      },
    ],
  };
  const check: CheckListEntry = {
    ...alertCheck,
    environment: {
      state: "kept",
      createdAt: timestamp,
      lastUsedAt: timestamp,
      expiresAt: "2026-01-01T00:30:00Z",
    },
  };
  await mockDashboard(page, {
    state: {
      tasks: [taskDetail.task, progressTask],
      projects: [exampleProject],
      memories: [{ ...groupMemory, project_id: project.id }],
      knowledge: [knowledge],
    },
    routes: {
      [`/api/tasks/${task.id}`]: taskDetail,
      [`/api/tasks/${task.id}/runs/${completedRun.id}/events`]: {
        events: runEvents,
        hasOlder: false,
        nextBefore: null,
      },
      "/api/codex/account": account,
      "/api/checks": [check],
      [`/api/checks/${check.id}`]:
        checkAttentionRoutes[`/api/checks/${check.id}`],
    },
  });
  await page.route(`**/api/checks/${check.id}/test`, (route) =>
    route.fulfill({ json: { outcome: "ok", summary: "示範設備試跑正常" } }),
  );
}

export const meetingPickList: PickList = {
  id: "example-meeting-risks",
  groupId: group.id,
  version: 1,
  createdAt: timestamp,
  items: [
    {
      id: "example-home",
      title: "首頁看板顯示今日待辦數量",
      summary: "在首頁看板顯示今天要處理的項目數。",
      riskReasons: [],
    },
    {
      id: "example-export",
      title: "報表匯出新增建立日期欄位",
      summary: "在匯出的報表增加建立日期。",
      riskReasons: [],
    },
    {
      id: "example-login",
      title: "登入頁加上忘記密碼連結",
      summary: "在登入頁加上找回帳號存取的入口。",
      riskReasons: ["涉及敏感功能，必須人工審核"],
    },
  ],
};

export const indexLimitedDetail: Detail = {
  ...detail,
  task: {
    ...task,
    title: meetingPickList.items[0].title,
    summary: meetingPickList.items[0].summary,
    mode: "change",
    project_routing: {
      status: "clear",
      basis: "project_description",
      reason: projectDescriptionPreselection,
      evidence: [],
      bindingVersion,
    },
  },
  projectReview: {
    binding_version: bindingVersion,
    config_version: project.config_version,
    project_name: project.name,
    repo: project.repo,
    base_branch: project.base_branch,
    group_name: group.name,
    confirmed: false,
    confirmation: null,
  },
};

export const answeredDetail: Detail = {
  ...detail,
  task: { ...task, status: "answered", answer: "示範報表每天更新一次。" },
  groupDeliveries: [
    {
      id: "demo-undelivered-answer",
      kind: "group_answered",
      created_at: timestamp,
      text: "示範報表每天更新一次。",
      delivery: {
        status: "pending",
        reason: "quota",
        note: "LINE 本月推播額度已用完",
      },
    },
  ],
};

export const defaultState: State = {
  stuckTasks: [],
  connectionSecrets: {
    lineSecret: { configured: true, updatedAt: null },
    lineToken: { configured: true, updatedAt: timestamp },
    discordToken: { configured: true, updatedAt: timestamp },
    discordApplicationId: { configured: false, updatedAt: null },
    openaiKey: { configured: false, updatedAt: null },
  },
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
    admin_notify_platform: "line",
    admin_discord_id: null,
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

export const unboundProject: Project = {
  ...project,
  id: "project-unbound",
  name: "示範專案",
};

export const unverifiedProject: Project = {
  ...project,
  id: "project-unverified",
  name: "範例專案",
  enabled: false,
  validated_at: null,
};

export const firstSetupHealth: State["health"] = [
  ...["github", "runner", "codex"].map((name) => ({
    name,
    ok: true,
    detail: "範例服務連線正常",
    checked_at: timestamp,
  })),
  { name: "line", ok: true, detail: "LINE 連線正常", checked_at: timestamp },
];

export const failedInferenceHealth: State["health"] = [
  ...firstSetupHealth.filter(({ name }) => name !== "codex"),
  { name: "codex", ok: false, detail: "真實推論未通過：訂閱上游回應失敗（上游 HTTP 502）。耗時 27 毫秒，請檢查訂閱代理。", checked_at: timestamp },
];

export const discordOnlySetup: Pick<
  State,
  "groups" | "integrations" | "health" | "connectionSecrets"
> = {
  groups: [discordGroup],
  integrations: { ...defaultState.integrations, line: false },
  health: [
    ...firstSetupHealth.filter((entry) => entry.name !== "line"),
    ...discordHealth,
  ],
  connectionSecrets: {
    ...defaultState.connectionSecrets!,
    lineSecret: { configured: false, updatedAt: null },
    lineToken: { configured: false, updatedAt: null },
  },
};

const reviewImageId = "demo-review-image";
const reviewImagePath = `/api/messages/${reviewImageId}/image`;

export function reviewWorkbenchFixture(now = Date.now()) {
  const tasks = Array.from({ length: 26 }, (_, index): Task => {
    const kind = index % 3;
    const created = new Date(now - (26 - index) * 25 * 60_000).toISOString();
    return {
      ...task,
      id: `demo-review-${index + 1}`,
      title: `核對範例需求 ${String(index + 1).padStart(2, "0")}`,
      mode: kind === 1 ? "query" : "change",
      project_id: kind === 2 ? null : project.id,
      target_branch: kind === 2 ? null : "main",
      group_id: kind === 1 ? discordGroup.id : group.id,
      created_at: created,
      updated_at: new Date(now).toISOString(),
      question: kind === 1 ? { text: "要整理哪一個月份？", choices: ["十月"] } : null,
      project_routing: {
        status: kind === 2 ? "uncertain" : "clear",
        basis: kind === 2 ? "none" : "explicit",
        reason: kind === 2 ? "訊息未指定專案。" : "需求原文指名測試專案。",
        evidence: kind === 2 ? [] : [
          { kind: "message", sourceId: "demo-review-source", quote: "測試專案" },
        ],
        bindingVersion: group.binding_version!,
      },
    };
  });
  const pickLists: PickList[] = Array.from({ length: 4 }, (_, index) => ({
    id: `demo-review-list-${index + 1}`,
    groupId: group.id,
    version: 1,
    createdAt: new Date(now - (45 - index * 5) * 60_000).toISOString(),
    items: [
      { id: `demo-pick-${index + 1}`, title: `整理範例清單 ${index + 1}`, summary: "彙整範例待辦。", riskReasons: [] },
    ],
  }));
  const state: State = {
    ...defaultState,
    groups: [group, discordGroup],
    settings: { ...defaultState.settings, admin_line_id: "demo-line" },
    health: ["github", "line", "runner", "codex", "openai", "tunnel", "notifications"].map((name) => ({
      name,
      ok: true,
      detail: "服務正常",
      checked_at: new Date(now).toISOString(),
    })),
    tasks: [...tasks].reverse(),
    pickLists,
  };
  const reviewSource = "請更新測試專案的範例畫面。";
  const details = new Map(tasks.map((entry, index) => {
    const source = {
      id: "demo-review-source",
      type: "text",
      text: reviewSource,
      sender: "小林",
      received_at: entry.created_at,
      revoked: false,
      availability: "readable" as const,
      has_image: false,
    };
    const entryDetail: Detail = {
      ...detail,
      task: entry,
      projectReview: {
        binding_version: group.binding_version!,
        config_version: entry.project_id ? project.config_version : null,
        project_name: entry.project_id ? project.name : null,
        repo: entry.project_id ? project.repo : null,
        base_branch: entry.target_branch,
        group_name: entry.group_id === group.id ? group.name : discordGroup.name,
        confirmed: false,
        confirmation: null,
      },
      sources: index === 0 ? [
        source,
        { ...source, id: reviewImageId, type: "image", text: null, has_image: true },
        { ...source, id: "demo-review-revoked", text: null, sender: null, revoked: true, availability: "revoked" as const },
        { ...source, id: "demo-review-expired", text: null, sender: null, revoked: true, availability: "expired" as const },
      ] : index === 1 ? [] : [source],
    };
    return [entry.id, entryDetail] as const;
  }));
  return { state, tasks, details, pickLists, reviewSource };
}

export function assignmentWorkbenchFixture(mode: Task["mode"]) {
  const fixture = reviewWorkbenchFixture();
  const unassigned = fixture.details.get(fixture.tasks[2].id)!;
  const pending: Task = {
    ...unassigned.task,
    mode,
    title: mode === "query" ? "說明範例報工流程" : "更新範例報工畫面",
  };
  const frontend: Project = {
    ...project,
    name: "示範前端",
    repo: "example/demo-frontend",
  };
  const backend: Project = {
    ...project,
    id: "23200000-0000-4000-8000-000000000002",
    name: "示範工單派送程式超長名稱範例專案".repeat(3),
    repo: `example/${"demo-backend".repeat(8)}`,
  };
  const state: State = {
    ...fixture.state,
    projects: [frontend, backend],
    groups: [{ ...group, project_ids: [frontend.id, backend.id] }],
    tasks: [pending],
    pickLists: [],
  };
  const details = new Map([[pending.id, { ...unassigned, task: pending }]]);
  return {
    ...fixture,
    state,
    details,
    tasks: [pending],
    pickLists: [],
    frontend,
    backend,
  };
}

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
const noActivityTask = { task_id: null, task_title: null, task_mode: null };
export const unchangedCleanup =
  "Docker 定期清理：刪除 0 個舊映像標籤；0 個懸空映像；建置快取 0.0 GB；映像共釋放 0.0 GB";
export const changedCleanup = unchangedCleanup.replace("刪除 0", "刪除 1");
export const derivedImageCleanup: State["activity"][number] = {
  id: 7,
  ...noActivityTask,
  kind: "derived_image_cleanup",
  detail: "已清除 2 個基底過舊的衍生映像，約釋放 3.0 GB",
  created_at: "2026-01-10T08:31:00Z",
};
export const repeatedActivity = "管理者 小林 更新示範專案的設定";
export const recentActivity: State["activity"] = [
  {
    ...activityTaskFields,
    id: 6,
    kind: "answered",
    detail: `查詢已回覆：${activityTask.title}`,
    created_at: "2026-01-10T08:30:00Z",
  },
  {
    id: 5,
    ...noActivityTask,
    kind: "settings",
    detail: repeatedActivity,
    created_at: "2026-01-10T08:25:00Z",
  },
  {
    id: 4,
    ...noActivityTask,
    kind: "docker_cleanup",
    detail: changedCleanup,
    created_at: "2026-01-10T08:24:00Z",
  },
  {
    id: 3,
    ...noActivityTask,
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
    ...noActivityTask,
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

export const inboxReviewTime = "2026-01-10T09:00:00Z";
export const inboxDetailUnavailable = "範例審核資料暫時無法讀取。";
export const summaryTasks = [activityTask, rejectedTask, cancelledTask, closedPrTask];
export const summaryActivity: State["activity"] = [activityTask, ...summaryTasks].map((entry, index) => ({
  id: 5 - index,
  task_id: entry.id,
  task_title: entry.title,
  task_mode: entry.mode,
  kind: "attempt",
  detail: entry.mode === "query" ? "開始調查" : "開始程式修改",
  created_at: new Date(Date.parse(inboxReviewTime) - index * 60_000).toISOString(),
}));

export async function mockInboxReview(page: Page) {
  const fixture = reviewWorkbenchFixture(Date.parse(inboxReviewTime));
  const titles = [
    "顯示匯出報表的日期範圍", "確認月份篩選的預設值", "為示範清單選擇專案",
    "整理月底對帳明細", "查詢匯出的資料筆數", "指定收據樣式的專案",
    "重新產生示範月報", "確認是否列出停用項目", "選擇通知設定的專案", "保留上次查詢的月份",
  ];
  const tasks = titles.map((title, index): Task => {
    const entry = fixture.tasks[index];
    return {
      ...entry, title,
      ...(index === 0 ? { created_at: "2026-01-09T08:00:00Z" } : {}),
      ...(index === 6 ? {
        status: "failed", updated_at: entry.created_at, last_error: "範例服務暫時沒有回應。",
      } : {}),
    };
  });
  const state: State = {
    ...fixture.state,
    tasks,
    pickLists: [],
    stuckTasks: [{ ...stuckTasks[1], taskId: tasks[0].id, title: tasks[0].title }],
    health: [
      ...fixture.state.health.filter(({ name }) => !exhaustedPushHealth.some((entry) => entry.name === name)),
      ...exhaustedPushHealth,
    ],
    activity: recentActivity,
  };
  const sourceEnd = "最後一項請保留原來的欄位順序。";
  const longSource = [
    "請幫示範專案整理月底的對帳明細，方便各組逐項核對。",
    ...Array.from({ length: 12 }, (_, index) =>
      `第 ${index + 1} 組使用範例表單。請分列日期、分類、筆數與小計，讓核對的人能回去找到原始紀錄。`,
    ),
    sourceEnd,
  ].join("\n");
  const details = Object.fromEntries(tasks.map((entry, index) => {
    const base = fixture.details.get(entry.id)!;
    const sources = index === 3
      ? fixture.details.get(tasks[0].id)!.sources.map((source) =>
          source.type === "text" && source.availability === "readable" ? { ...source, text: longSource } : source)
      : base.sources;
    return [`/api/tasks/${entry.id}`, { ...base, task: entry, sources } satisfies Detail];
  }));
  await page.clock.setFixedTime(new Date(inboxReviewTime));
  await mockDashboard(page, { state: { ...state }, routes: details });
  await page.route(/\/api\/state(\?|$)/, (route) => route.fulfill({ json: state }));
  return { state, tasks, sourceEnd };
}

export async function mockDashboard(
  page: Page,
  options: {
    state?: Record<string, unknown>;
    routes?: Record<string, unknown>;
    pairingCodes?: Partial<Record<"line" | "discord", string>>;
    reauthConnectionSecrets?: boolean;
  } = {},
): Promise<void> {
  const state = { ...defaultState, ...options.state } as State;
  if (state.totals) {
    state.totals = { mergedWeekDay: mergedWeekDay(), ...state.totals };
  }
  const routes: Record<string, unknown> = {
    "/api/public/status": { githubConfigured: true },
    "/api/me": {
      id: "1",
      login: "demo-admin",
      csrf: "test-only",
      role: "admin",
      owner: true,
    },
    "/api/state": state,
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
    if (request.method() === "GET" && pathname === reviewImagePath) {
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAPAAAAFoAQAAAABBbEulAAAAIklEQVR4nO3BMQEAAADCoPVPbQhfoAAAAAAAAAAAAACA1wArmAAB3qaDtgAAAABJRU5ErkJggg==",
          "base64",
        ),
      });
    }
    if (request.method() === "PUT" && pathname === "/api/secrets") {
      if (!(routes["/api/me"] as { owner?: boolean }).owner)
        return route.fulfill({ status: 403, json: { error: "連線金鑰只有擁有者能更新" } });
      if (options.reauthConnectionSecrets)
        return route.fulfill({ status: 409, json: { error: secretReauthMessage } });
      const parsed = parseConnectionSecrets(request.postDataJSON());
      if ("error" in parsed) return route.fulfill({ status: 400, json: parsed });
      const state = routes["/api/state"] as State;
      const connectionSecrets = { ...state.connectionSecrets } as ConnectionSecretStatus;
      for (const field of connectionSecretFields) {
        const value = parsed.patch[field];
        if (value !== undefined)
          connectionSecrets[field] = { configured: value !== null, updatedAt: new Date().toISOString() };
      }
      state.connectionSecrets = connectionSecrets;
      return route.fulfill({ json: { connectionSecrets } });
    }
    // 任務頁「已結束／全部」分批讀取：預設用狀態快照裡的任務回應，個別測試可自行覆寫。
    if (request.method() === "GET" && pathname === "/api/tasks") {
      const params = new URL(request.url()).searchParams;
      const closed = params.get("filter") === "closed";
      const week = mergedWeekBounds(params.get("mergedWeek") ?? "");
      const tasks = ((routes["/api/state"] as { tasks?: Task[] }).tasks ?? [])
        .filter((entry) =>
          week
            ? isMergedInWeek(entry, week)
            : !closed || endedStatuses.includes(entry.status),
        )
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return route.fulfill({ json: { tasks, next: null } });
    }
    if (request.method() === "POST" && pathname === "/api/alerts/seen") {
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() === "POST" && pathname === "/api/pairing" && options.pairingCodes) {
      const { platform = state.settings.admin_notify_platform ?? "line" } =
        (request.postDataJSON() ?? {}) as { platform?: unknown };
      const code = platform === "line" || platform === "discord"
        ? options.pairingCodes[platform]
        : undefined;
      if (code) return route.fulfill({ json: { code, expiresIn: 600 } });
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
