import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
// 與生產情報助理共用的元件會傳入 Portal 容器；看板直接掛在 body。
export function resolvePortalContainer(
  container?: Element | DocumentFragment | null,
) {
  return container ?? undefined;
}
