/** 使用摩擦指標：每件任務需要人回應、切到看板的次數，以及等待時間等。 */
export interface FrictionMetrics {
  days: number;
  groupId: string | null;
  tasks: number;
  /** 每件任務平均需要人回應幾次。 */
  responsesPerTask: number | null;
  /** 每件任務平均需要切到看板操作幾次。 */
  dashboardPerTask: number | null;
  /** 重講背景：沒有接上前一題，30 分鐘內又在同群組明確指名同一專案。 */
  restated: number;
  /** 接錯題：使用者改正接續對象的次數。 */
  relinked: number;
  /** 從訊息送出到機器人第一則群組訊息的秒數中位數（「收到」用 reply token、不留紀錄，不含在內）。 */
  firstReplySeconds: number | null;
  /** 查詢從提出到回答的秒數中位數。 */
  answerSeconds: number | null;
  /** 修改合併後 7 天內，同一需求又追加修改的比例。 */
  reworkRate: number | null;
  reworkBase: number;
}
