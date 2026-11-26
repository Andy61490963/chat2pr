import * as React from "react";
import { CheckIcon } from "lucide-react";
import {
  Checkbox as CheckboxPrimitive,
  Label as LabelPrimitive,
  Progress as ProgressPrimitive,
  Separator as SeparatorPrimitive,
  Switch as SwitchPrimitive,
  Tabs as TabsPrimitive,
} from "radix-ui";
import { cn } from "@/lib/utils";

function Label({
  className,
  layout = "inline",
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root> & { layout?: "inline" | "stacked" }) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        layout === "stacked" && "flex-col gap-1",
        className,
      )}
      {...props}
    />
  );
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:focus-frame disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer group grid size-11 shrink-0 place-items-center rounded-sm outline-none focus-visible:focus-frame disabled:cursor-not-allowed disabled:opacity-50 md:size-4",
        className,
      )}
      {...props}
    >
      <span className="grid size-4 place-content-center rounded-sm border border-input group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary group-data-[state=checked]:text-primary-foreground">
        <CheckboxPrimitive.Indicator data-slot="checkbox-indicator">
          <CheckIcon className="size-3.5" />
        </CheckboxPrimitive.Indicator>
      </span>
    </CheckboxPrimitive.Root>
  );
}

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer group inline-grid shrink-0 place-items-center rounded-md outline-none focus-visible:focus-frame disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="inline-flex h-5 w-8 items-center rounded-md border border-transparent bg-input group-data-[state=checked]:bg-primary dark:group-data-[state=unchecked]:bg-input/80">
        <SwitchPrimitive.Thumb
          data-slot="switch-thumb"
          className="pointer-events-none block size-4 rounded-md bg-background transition-transform data-[state=checked]:translate-x-3.5 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground"
        />
      </span>
    </SwitchPrimitive.Root>
  );
}

function Progress({
  className,
  value,
  indicatorClassName,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  indicatorClassName?: string;
}) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-md bg-primary/15",
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "h-full w-full flex-1 bg-primary transition-all",
          indicatorClassName,
        )}
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

const TabsContent = TabsPrimitive.Content;
const segmentedListClass =
  "inline-flex h-auto w-fit max-w-full items-center justify-start overflow-x-auto rounded-md bg-muted p-1 md:h-9 text-muted-foreground";
const segmentedItemClass =
  "inline-flex h-full flex-none items-center justify-center gap-1.5 rounded-md border border-transparent px-2.5 py-1 text-sm font-medium whitespace-nowrap text-foreground transition-colors focus-visible:border-ring focus-visible:focus-frame disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-popover dark:text-muted-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-background dark:data-[state=active]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

function TabsList({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useImperativeHandle(ref, () => listRef.current!, []);
  React.useEffect(() => {
    const list = listRef.current;
    if (!list || list.dataset.orientation === "vertical") return;
    // 先讓初次分頁切換完成。字型載入會改變標籤寬度，只在捲動位置未變時再對齊一次。
    let mounted = true;
    const frame = requestAnimationFrame(() => {
      const start = list.scrollLeft;
      void document.fonts.ready.then(() => {
        if (!mounted || list.scrollLeft !== start) return;
        const selected = list.querySelector(
          '[role="tab"][aria-selected="true"]',
        );
        if (!selected || list.scrollWidth <= list.clientWidth) return;
        const bounds = list.getBoundingClientRect();
        const item = selected.getBoundingClientRect();
        const padding = getComputedStyle(list);
        const edge = bounds.left + list.clientLeft;
        const left = edge + parseFloat(padding.paddingLeft);
        const right = edge + list.clientWidth - parseFloat(padding.paddingRight);
        if (item.right > right) list.scrollLeft += Math.ceil(item.right - right);
        else if (item.left < left) list.scrollLeft += Math.floor(item.left - left);
      });
    });
    return () => {
      mounted = false;
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <TabsPrimitive.List
      ref={listRef}
      data-slot="tabs-list"
      className={cn(segmentedListClass, className)}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(segmentedItemClass, className)}
      {...props}
    />
  );
}

export {
  Checkbox,
  Label,
  Progress,
  Separator,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  segmentedListClass,
  segmentedItemClass,
};
