import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PageNotices({
  incident,
  count,
  subdued = false,
  children,
}: {
  incident: string | null | undefined;
  count: number;
  subdued?: boolean;
  children: ReactNode;
}) {
  const contentId = useId();
  const storageKey = "agentflow-collapsed-page-notices";
  const [saved, setSaved] = useState(() => {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  const remember = (value: string | null) => {
    setSaved(value);
    try {
      if (value === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, value);
    } catch {
      // 瀏覽器無法保存時，仍可在目前頁面收合。
    }
  };

  useEffect(() => {
    if (incident !== undefined && saved !== null && saved !== incident)
      remember(null);
  }, [incident, saved]);

  if (!incident || !count) return null;
  const collapsed = saved === incident;
  return (
    <div className={cn("mb-4 flex flex-wrap items-start gap-x-2 gap-y-1 border-y border-warn/40 bg-warn-soft px-2 text-warn", subdued && "mb-2 rounded-md border-0 bg-muted text-muted-foreground")}>
      <div
        id={contentId}
        hidden={collapsed}
        className="min-w-0 flex-[1_1_12rem]"
      >
        {children}
      </div>
      <Button
        type="button"
        variant="ghost"
        size={collapsed ? "sm" : "icon-sm"}
        className="ml-auto text-inherit max-md:min-h-11 max-md:min-w-11"
        aria-label={collapsed ? undefined : "收合頁首警示"}
        aria-controls={contentId}
        aria-expanded={!collapsed}
        onClick={() => remember(collapsed ? null : incident)}
      >
        {collapsed ? (
          <>
            展開頁首警示（{count}） <ChevronDown />
          </>
        ) : (
          <ChevronUp />
        )}
      </Button>
    </div>
  );
}
