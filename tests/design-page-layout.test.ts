import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { defaultState, project } from "../e2e/dashboard-fixture";
import { Empty, SectionTitle } from "../src/app/shared";
import { MembersView } from "../src/app/members";
import { MemoryOverview } from "../src/app/memory-overview";
import { ProjectContextEditor } from "../src/app/project-context";
import { DescriptionItem } from "../src/components/ui/description-list";
import {
  EmptyState,
  InlineNotice,
  SectionHeader,
} from "../src/components/ui/layout";

it("專案待補資料的警告標題有狀態色，原因與回答表單使用一般文字", () => {
  const markup = render(
    h(ProjectContextEditor, {
      project: {
        ...project,
        setup_input: {
          id: "demo",
          configVersion: 1,
          reason: "範例設備缺少站別",
          questions: [{ kind: "information", question: "請提供站別" }],
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
      busy: false,
      request: vi.fn(),
      run: vi.fn(),
    }),
  );
  const banner = markup.match(/<div[^>]*role="status"[^>]*>/)?.[0] ?? "";
  expect(banner).toContain("bg-warn-soft");
  expect(banner.split(/[" ]/)).not.toContain("text-warn");
  expect(markup).toMatch(
    /<h4 class="[^"]*text-warn[^"]*">還需要你提供一點資訊/,
  );
  expect(markup).toContain("請提供站別");
});

it("通知選單的提示列只有底部的分隔線", () => {
  const markup = render(
    h(
      InlineNotice,
      { as: "p", tone: "warn", variant: "strip" },
      "通知額度已用完",
    ),
  );
  const classes = markup.match(/class="([^"]+)"/)?.[1].split(" ");
  expect(classes).toContain("border-b");
  expect(classes).not.toContain("border");
  expect(classes).not.toContain("rounded-sm");
});

it("鍵值列的多行與輔助字級只影響值，標籤維持內文字級", () => {
  const markup = render(
    h(DescriptionItem, {
      label: "範圍",
      children: "範例目錄",
      valueClassName: "whitespace-pre-wrap text-xs",
    }),
  );
  expect(markup).toMatch(
    /<dd class="[^"]*whitespace-pre-wrap text-xs[^"]*">範例目錄/,
  );
  expect(markup).not.toMatch(/<(?:div|dt)[^>]*class="[^"]*text-xs/);
});

it("既有與遷移頁的空狀態呈現一致，含緊湊版與圖示", () => {
  for (const compact of [true, false]) {
    const props = {
      compact,
      title: "沒有範例設備",
      icon: h("svg"),
      children: "請新增設備",
    };
    expect(render(h(Empty, props))).toBe(render(h(EmptyState, props)));
  }
});

it("既有與遷移頁的區塊標題、零筆計數與操作具有一致層級", () => {
  const props = {
    children: "範例設備",
    count: 0,
    action: h("button", {}, "新增"),
  };
  expect(render(h(SectionTitle, props))).toBe(
    render(h(SectionHeader, { ...props, className: "mb-3" })),
  );
});

it("看板主殼使用共用側欄與頁首，警示對話框有正式呼叫端才提供", () => {
  const source = (path: string) => readFileSync(path, "utf8");
  const app = [
    source("src/App.tsx"),
    ...readdirSync("src/app")
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => source("src/app/" + file)),
  ].join("\n");
  const layout = source("src/components/ui/layout.tsx");
  expect(layout).toContain("export function PageHeader(");
  expect(app).toMatch(/<PageHeader[\s>]/);
  expect(app).toMatch(/<Sidebar[\s>]/);
  if (existsSync("src/components/ui/alert-dialog.tsx"))
    expect(app).toContain('from "@/components/ui/alert-dialog"');
});

it("記憶總覽以二級標題區分摘要和清單", () => {
  const markup = render(
    h(MemoryOverview, { state: defaultState, go: vi.fn() }),
  );
  expect(markup).toMatch(/<h2[^>]*>記憶總覽<\/h2>/);
  expect(markup).not.toContain('data-slot="card"');
});

it("成員頁用二級標題區分表單和名單", () => {
  const markup = render(
    h(MembersView, { request: vi.fn(), run: vi.fn(), busy: false, me: "demo" }),
  );
  expect(markup).toMatch(/<h2[^>]*>加入成員<\/h2>/);
  expect(markup).toMatch(/<h2[^>]*>成員名單<\/h2>/);
  expect(markup).not.toContain('data-slot="card"');
});
