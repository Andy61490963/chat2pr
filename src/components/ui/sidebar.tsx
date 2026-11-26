import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Sidebar({
  label,
  brand,
  children,
  footer,
  className,
  ...props
}: ComponentProps<"aside"> & {
  label: string;
  brand?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <aside
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 border-t bg-sidebar pb-safe text-sidebar-foreground md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:gap-6 md:border-t-0 md:border-r md:px-3 md:py-4",
        className,
      )}
      {...props}
    >
      {brand && (
        <div className="hidden items-center gap-2 px-2 md:flex">{brand}</div>
      )}
      <nav
        aria-label={label}
        className="flex justify-around md:flex-col md:justify-start md:gap-1"
      >
        {children}
      </nav>
      {footer && <div className="mt-auto hidden md:block">{footer}</div>}
    </aside>
  );
}

export function SidebarItem({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "relative flex min-h-11 flex-1 flex-col items-center justify-center gap-1 px-1 py-2 text-caption text-muted-foreground hover:text-foreground focus-visible:focus-frame aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground md:min-h-0 md:flex-none md:flex-row md:justify-start md:gap-3 md:rounded-md md:px-3 md:py-2 md:text-sm md:hover:bg-sidebar-accent",
        className,
      )}
      {...props}
    />
  );
}
