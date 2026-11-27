import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { PickList } from "../../shared/pick-list.js";
import { pickListLabels } from "../../shared/status-glossary.js";
import { ConfirmButton } from "./confirm";
import { useUnsaved } from "./unsaved";

const actionClass =
  "min-h-11 max-w-full whitespace-normal motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground";

export function PickListForm({
  list,
  group,
  busy,
  resolve,
  onPrimaryMount,
  mobile,
}: {
  list: PickList;
  group: string;
  busy: boolean;
  resolve: (ids: string[]) => unknown;
  onPrimaryMount: (button: HTMLButtonElement | null) => void;
  mobile: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  useUnsaved("task-pick-list", selected.length > 0);
  const canCreate = !busy && selected.length > 0;
  const actions = (
    <div className="flex shrink-0 flex-wrap gap-2 max-lg:border-t max-lg:py-3 lg:mt-4">
      <Button
        ref={onPrimaryMount}
        type="button"
        className={`${actionClass} aria-disabled:opacity-50`}
        aria-disabled={!canCreate || undefined}
        onClick={() => {
          if (canCreate) void resolve(selected);
        }}
      >
        建立選取的任務
      </Button>
      <ConfirmButton
        variant="outline"
        className={`${actionClass} border-muted-foreground dark:border-muted-foreground`}
        dialogActionClassName={actionClass}
        disabled={busy}
        title={`這 ${list.items.length} 項待辦全部不做？`}
        description="你會結束這張清單，清單裡的項目都不會建立任務。"
        confirm="全部不做"
        dismiss="返回清單"
        onConfirm={() => resolve([])}
      >
        全部不做
      </ConfirmButton>
    </div>
  );
  return (
    <article
      className="min-w-0 p-4 wrap-anywhere max-lg:flex max-lg:min-h-0 max-lg:flex-1 max-lg:flex-col max-lg:pb-0"
      aria-labelledby={`pick-list-${list.id}`}
    >
      <h2 id={`pick-list-${list.id}`} className="font-semibold">
        {pickListLabels.pending}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{group}</p>
      {!mobile && actions}
      <fieldset className="mt-4 min-w-0 max-lg:min-h-0 max-lg:flex-1 max-lg:overflow-y-auto" disabled={busy}>
        <legend className="text-sm">
          勾選你要建立的任務，送出後這張清單就會結束。
        </legend>
        <ul className="mt-2 divide-y">
          {list.items.map((item) => (
            <li key={item.id}>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 py-2">
                <input
                  type="checkbox"
                  className="size-5 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                  aria-labelledby={`pick-title-${item.id}`}
                  aria-describedby={
                    item.riskReasons.length
                      ? `pick-summary-${item.id} pick-risk-${item.id}`
                      : `pick-summary-${item.id}`
                  }
                  checked={selected.includes(item.id)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelected((ids) =>
                      checked
                        ? [...ids, item.id]
                        : ids.filter((id) => id !== item.id),
                    );
                  }}
                />
                <span className="min-w-0">
                  <span
                    id={`pick-title-${item.id}`}
                    className="block font-medium"
                  >
                    {item.title}
                  </span>
                  <span
                    id={`pick-summary-${item.id}`}
                    className="block text-sm text-muted-foreground"
                  >
                    {item.summary}
                  </span>
                  {item.riskReasons.length > 0 && (
                    <span
                      id={`pick-risk-${item.id}`}
                      className="block text-sm text-warn"
                    >
                      {item.riskReasons.join("。")}
                    </span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {mobile && actions}
    </article>
  );
}
