import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Sidebar({
  label,
  brand,
  footer,
  children,
  className,
}: {
  label: string;
  brand: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <aside
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 border-t bg-sidebar pb-safe-inset md:sticky md:top-0 md:flex md:h-screen md:flex-col md:gap-6 md:border-t-0 md:border-r md:px-3 md:py-4",
        className,
      )}
    >
      <div className="hidden items-center gap-2.5 px-2 md:flex">{brand}</div>
      <nav
        aria-label={label}
        className="flex justify-around md:flex-col md:justify-start md:gap-0.5"
      >
        {children}
      </nav>
      {footer && (
        <div className="mt-auto hidden flex-col gap-3 md:flex">{footer}</div>
      )}
    </aside>
  );
}

export function SidebarButton({
  className,
  ...props
}: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "relative flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-caption text-muted-foreground transition-colors hover:text-foreground md:min-h-0 md:flex-none md:flex-row md:justify-start md:gap-3 md:rounded-md md:px-3 md:py-1.5 md:text-sm md:hover:bg-sidebar-accent",
        props["aria-current"] === "page" &&
          "bg-sidebar-accent font-medium text-foreground",
        className,
      )}
    />
  );
}
