const titles = [
  "LINE 群組自動辨識查詢並回答", "Discord 修改經核准、測試與審查後收到合併通知",
  "從待挑選清單選兩項並分別完成", "接續上題查詢並回覆",
  "群組回答補問後繼續", "敏感變更經人工核准後沿用候選修改", "選擇無法判讀的專案後完成",
  "拒絕原因適用於同群組後續類似需求", "父任務追加需求僅建立增量子任務",
  "修復基底測試後以新基底重試", "首次逾時接續、再次逾時明確失敗", "暫時故障退避後恢復",
  "不可恢復的模型錯誤不重試", "額度恢復後繼續", "取消、改版及撤回執行中的需求",
  "執行器重啟回收中斷工作", "記憶體恢復後重新派工", "次數或預算用盡時說明等待原因",
  "安裝或容器建立失敗時說明原因", "討論串與額度不足時的看板通知",
] as const;

const cases = titles.map((title, index) => ({ number: index + 1, id: `F${String(index + 1).padStart(2, "0")}`, title }));

export function selectFlowCases(args: readonly string[]) {
  const real = args.includes("--real");
  const fault = args.includes("--fault=model") ? "model" : args.includes("--fault=pr") ? "pr" : undefined;
  const ids = args.filter(arg => /^\d{1,2}$/.test(arg));
  if (ids.length > 1 || args.length !== ids.length + Number(real) + Number(!!fault)) throw new Error("請指定一個情境編號，可加 --real 或單一 --fault 參數");
  const number = ids.length ? Number(ids[0]) : real ? 1 : undefined;
  const selected = number === undefined ? cases : cases.filter(item => item.number === number);
  if (!selected.length || (real && (number !== 1 || fault)) || (fault && number !== (fault === "pr" ? 2 : 1))) throw new Error("編號限 1 至 20；真實模型只跑情境 1，故障注入限對應的固定劇本");
  return { real, fault, cases: selected } as const;
}
