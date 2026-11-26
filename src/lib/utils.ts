import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// 合併呼叫端樣式時，要能區分同前綴的設計代幣，例如 text-caption 是字級。
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["caption"],
      leading: ["heading", "label", "body"],
      shadow: ["raised"],
      container: ["diagram-measure"],
    },
    classGroups: {
      "grid-cols": [{ "grid-cols": [
        "action", "group", "project", "form-action", "status-options",
        "task-tabs", "description", "description-pairs",
      ] }],
      w: ["w-media-dialog", "w-disk-used"],
      h: ["h-select-trigger"],
      "min-w": ["min-w-select-trigger"],
      "max-w": ["max-w-overlay", "max-w-media-dialog", "max-w-select-available"],
      "max-h": ["max-h-sheet", "max-h-media", "max-h-notifications", "max-h-floating"],
      "transform-origin": ["origin-floating"],
      pb: ["pb-safe"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
// 與生產情報助理共用的元件會傳入 Portal 容器；看板直接掛在 body。
export function resolvePortalContainer(
  container?: Element | DocumentFragment | null,
) {
  return container ?? undefined;
}
