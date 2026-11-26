import { cn } from "@/lib/utils";

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex min-w-0 flex-col leading-tight", className)}>
      <span className="truncate text-sm font-semibold tracking-tight">
        chat2pr
      </span>
      <span className="truncate text-caption text-muted-foreground">
        群組需求到 PR
      </span>
    </span>
  );
}
