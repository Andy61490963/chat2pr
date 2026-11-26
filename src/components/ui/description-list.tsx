import * as React from "react";
import { cn } from "@/lib/utils";

// 「標籤／值」兩欄：標籤靠左對齊成一欄，值從同一條線開始。
// pairs={2} 在寬度夠時一列放兩組，讓資訊短的標頭不會拉得太高。
function DescriptionList({
  className,
  pairs = 1,
  ...props
}: React.ComponentProps<"dl"> & { pairs?: 1 | 2 }) {
  return (
    <dl
      data-slot="description-list"
      className={cn(
        "grid grid-cols-description gap-x-4 gap-y-1.5 text-sm",
        pairs === 2 &&
          // 第一組的值只佔內容寬度，第二組緊跟在後（用左內距分組），兩組不會被拉到畫面兩端。
          "sm:grid-cols-description-pairs sm:[&>*:nth-child(even)>dt]:pl-6",
        className,
      )}
      {...props}
    />
  );
}

function DescriptionItem({
  label,
  numeric = false,
  className,
  valueClassName,
  children,
}: {
  label: React.ReactNode;
  numeric?: boolean;
  className?: string;
  valueClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-slot="description-item"
      className={cn("col-span-2 grid grid-cols-subgrid items-baseline", className)}
    >
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-foreground wrap-anywhere",
          numeric && "tabular-nums",
          valueClassName,
        )}
      >
        {children}
      </dd>
    </div>
  );
}

export { DescriptionList, DescriptionItem };
