import { cn } from "@/lib/utils";

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex min-w-0 flex-col leading-tight", className)}>
      <span className="truncate text-[15px] font-semibold tracking-tight">
        chat2pr
      </span>
      <span className="truncate text-[11px] text-muted-foreground">
        LINE 需求到 PR
      </span>
    </span>
  );
}
