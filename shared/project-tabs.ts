export const projectTabs = {
  overview: "概況",
  environment: "環境驗證",
  access: "連線與權限",
  memory: "記憶",
} as const;

export type ProjectTab = keyof typeof projectTabs;
export type ProjectLocation = { id: string; tab: ProjectTab };
export const defaultProjectTab: ProjectTab = "overview";

export function readProjectTab(value: string | null): ProjectTab {
  return value && Object.hasOwn(projectTabs, value)
    ? (value as ProjectTab)
    : defaultProjectTab;
}

export function projectFromUrl(url: URL): ProjectLocation | null {
  const id = url.searchParams.get("project");
  return url.pathname.replace(/\/+$/, "") === "/projects" && id
    ? { id, tab: readProjectTab(url.searchParams.get("tab")) }
    : null;
}
