import { notificationLabels } from "./status-glossary.js";

export const linePrivateModes = ["action", "all"] as const;
export type LinePrivateMode = (typeof linePrivateModes)[number];

export const linePrivateDefaults = {
  line_private_mode: "action",
  line_group_reserve_percent: 70,
} as const;

export const linePrivateModeLabels = {
  action: "只私訊需要動手的事",
  all: "所有通知都私訊",
} satisfies Record<LinePrivateMode, string>;

export const lineGroupReserveLabel = "保留給群組回覆的比例（%）";
export const linePrivateDigestMinutes = 10;
export const lineServiceOutageMinutes = 15;

export function linePrivateQuotaHold(
  usage: { limit: number | null; used: number } | null,
  reserve: number,
) {
  // 尚無用量時照常嘗試推播，由 LINE 回應判定是否達到月上限。
  if (!usage) return null;
  if (reserve === 100) return "reserved";
  if (usage.limit === null || reserve === 0) return null;
  return usage.used * 100 >= usage.limit * (100 - reserve) ||
    (usage.used + 1) * 100 > usage.limit * (100 - reserve)
    ? "reserved"
    : null;
}

export const linePrivateQuotaNotes = {
  reserved: `你已保留剩餘額度給群組回覆，${notificationLabels.privatePushPaused}期間請查看看板鈴鐺。`,
};
