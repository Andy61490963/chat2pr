import type {
  ComponentPropsWithoutRef,
  HTMLAttributes,
  ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { Badge } from "./badge";

export function PageHeader({
  children,
  description,
  action,
  className,
  ...props
}: ComponentPropsWithoutRef<"header"> & {
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-start justify-between gap-3",
        className,
      )}
      {...props}
    >
      <div className="min-w-0">
        <h1 className="heading-page">{children}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </header>
  );
}

export function SectionHeader({
  children,
  count,
  action,
  as: Heading = "h2",
  id,
  className,
}: {
  children: ReactNode;
  count?: number;
  action?: ReactNode;
  as?: "h2" | "h3" | "h4";
  id?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <Heading
        id={id}
        className={Heading === "h2" ? "heading-section" : "text-sm font-medium"}
      >
        {children}
      </Heading>
      {count !== undefined && <Badge variant="secondary">{count}</Badge>}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  icon,
  compact,
  children,
  className,
}: {
  title: string;
  icon?: ReactNode;
  compact?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex text-sm",
        compact
          ? "items-start gap-3 px-5 py-4"
          : "flex-col items-center gap-2 px-4 py-10 text-center",
        className,
      )}
    >
      {icon && (
        <span
          aria-hidden
          className={cn(
            "shrink-0 text-muted-foreground",
            compact ? "[&_svg]:size-4" : "[&_svg]:size-5",
          )}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <p className={compact ? "text-muted-foreground" : "font-medium"}>
          {title}
        </p>
        {children && (
          <div
            className={cn(
              "mt-1 text-muted-foreground",
              compact ? "text-xs" : "max-w-sm",
            )}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

export function Toolbar({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-2", className)}
      {...props}
    />
  );
}

export function DataList({
  as: List = "ul",
  variant = "plain",
  className,
  ...props
}: ComponentPropsWithoutRef<"ol"> & {
  as?: "ul" | "ol";
  variant?: "plain" | "bordered" | "responsive";
}) {
  return (
    <List
      className={cn(
        variant === "responsive"
          ? "grid gap-3 @3xl:block @3xl:divide-y"
          : "divide-y",
        variant === "bordered" && "rounded-md border",
        className,
      )}
      {...props}
    />
  );
}

export function DataListFrame({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "@3xl:rounded-md @3xl:border @3xl:bg-card @3xl:text-card-foreground",
        className,
      )}
      {...props}
    />
  );
}

const listColumns = {
  group: "@3xl:grid-cols-group",
  project: "@3xl:grid-cols-project",
};

export function DataListHeader({
  columns,
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & { columns: keyof typeof listColumns }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "hidden gap-4 border-b px-5 py-2.5 text-xs text-muted-foreground @3xl:grid",
        listColumns[columns],
        className,
      )}
      {...props}
    />
  );
}

export function ListRowButton({
  columns,
  className,
  ...props
}: ComponentPropsWithoutRef<"button"> & { columns: keyof typeof listColumns }) {
  return (
    <button
      type="button"
      className={cn(
        "grid min-h-11 w-full grid-cols-action items-start gap-x-4 gap-y-2 rounded-md px-5 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:focus-frame @3xl:items-center @3xl:rounded-none",
        listColumns[columns],
        className,
      )}
      {...props}
    />
  );
}

export function ListRow({
  variant = "plain",
  className,
  ...props
}: ComponentPropsWithoutRef<"li"> & { variant?: "plain" | "responsive" }) {
  return (
    <li
      className={cn(
        variant === "responsive"
          ? "rounded-md border bg-card text-card-foreground @3xl:rounded-none @3xl:border-0"
          : "px-3 py-2",
        className,
      )}
      {...props}
    />
  );
}

const noticeColors = {
  good: "border-good/30 bg-good-soft text-good",
  warn: "border-warn/30 bg-warn-soft text-foreground",
  danger: "border-danger/30 bg-danger-soft text-danger",
  info: "border-border bg-info-soft text-info",
  muted: "border-border bg-muted text-muted-foreground",
};

export function InlineNotice({
  as: Element = "div",
  tone = "info",
  variant = "panel",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: "div" | "p";
  tone?: keyof typeof noticeColors;
  variant?: "panel" | "strip";
}) {
  return (
    <Element
      className={cn(
        "px-3 py-2 text-sm",
        variant === "strip" ? "border-b" : "rounded-sm border",
        noticeColors[tone],
        className,
      )}
      {...props}
    />
  );
}
