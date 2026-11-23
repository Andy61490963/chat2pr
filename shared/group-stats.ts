/** 群組近 30 天建立的修改需求，以及其中核准過與被拒絕的數量。 */
export interface GroupChangeStats {
  created: number;
  approved: number;
  rejected: number;
}

export const groupChangeStatsDays = 30;

// 自動辨識的群組多數需求都被拒絕時，建議改成只用 /任務 觸發；數量太少時不下結論。
export function mostlyRejected({ created, rejected }: GroupChangeStats) {
  return rejected >= 5 && rejected * 2 >= created;
}
