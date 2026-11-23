import { notificationLabels } from "./status-glossary.js";

// 探測原文只用於比對，通知一律採用表內的說明。新增對照時請補上測試樣本。
const failureDescriptions = [
  {
    matches: /可用記憶體.*已回升/,
    explanation:
      "主機記憶體不足，系統已暫停派新工作；記憶體目前已回升，穩定 5 分鐘後會自動恢復派工。",
  },
  {
    matches: /可用記憶體.*(?:低於|尚未回升)/,
    explanation:
      "主機記憶體不足，系統已暫停派新工作。請到系統頁查看記憶體用量，並關閉暫時用不到的程式。",
  },
  {
    matches: /Codex 尚未登入/i,
    explanation:
      "系統讀不到訂閱，服務帳號可能尚未登入或登入已到期。請在主機上重新登入 Codex。",
  },
  {
    matches: /尚未設定|模型尚無費率設定/,
    explanation:
      "服務目前無法使用，所需設定可能未填齊。請到設定頁確認服務設定，再按「檢查連線」。",
  },
  {
    matches: /TimeoutError|timed?\s*out|ETIMEDOUT|逾時|無回應|沒有回應/i,
    explanation:
      "服務沒有在預期時間內回應，可能是網路不穩或服務忙碌。請稍候到設定頁按「檢查連線」，若仍異常，請確認網路和服務是否正常。",
  },
  {
    matches: /ECONNREFUSED|connection refused|連線遭拒/i,
    explanation:
      "系統連不上服務，服務可能還沒啟動。請確認服務已啟動，再到設定頁按「檢查連線」。",
  },
  {
    matches: /fetch failed|ENOTFOUND|ECONNRESET|無法連線|連不上/i,
    explanation:
      "系統連不上服務，可能是網路中斷或服務暫時無法使用。請確認網路和服務是否正常，再到設定頁按「檢查連線」。",
  },
  {
    matches: /驗證失敗|模型存取失敗|\b(?:401|403)\b/,
    explanation:
      "系統無法使用服務，憑證可能已失效或權限不足。請到設定頁核對憑證和權限，再按「檢查連線」。",
  },
];

export function serviceDownText(name: string, label: string, detail: string) {
  const explanation =
    name === "tunnel"
      ? "外部連不到看板，群組訊息也可能送不進來。可能是主機網路中斷或入口程序停止。請確認主機網路與維持入口的程序是否正常。"
      : (failureDescriptions.find(({ matches }) => matches.test(detail))
          ?.explanation ??
        "服務目前無法使用，可能是服務暫時異常或設定有誤。請到設定頁查看服務狀態並確認設定，再按「檢查連線」。");
  return `${notificationLabels.serviceDown}：${label}。${explanation}`;
}
