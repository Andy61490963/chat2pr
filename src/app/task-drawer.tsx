import { useRef } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  TaskReviewPanel,
  type TaskReviewPanelProps,
} from "./task-review-panel";

export function TaskDrawer({
  close,
  ...panel
}: Omit<TaskReviewPanelProps, "reviewStatus" | "onPrimaryMount"> & {
  close: () => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent
        ref={content}
        className="sm:max-w-2xl"
        onOpenAutoFocus={(event) => {
          const title =
            content.current?.querySelector<HTMLElement>("[data-task-title]");
          if (!title) return;
          event.preventDefault();
          title.focus({ preventScroll: true });
        }}
      >
        <TaskReviewPanel {...panel} />
      </SheetContent>
    </Sheet>
  );
}
