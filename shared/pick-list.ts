export interface PickList {
  id: string;
  groupId: string;
  version: number;
  createdAt?: string;
  items: { id: string; title: string; summary: string; riskReasons: string[] }[];
}
