export interface PickList {
  id: string;
  groupId: string;
  version: number;
  items: { id: string; title: string; summary: string; riskReasons: string[] }[];
}
