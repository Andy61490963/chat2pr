import { AppError } from "./policy.js";
import { clip } from "./pr-body.js";

const alreadySatisfiedMark = "AGENTFLOW_ALREADY_SATISFIED";
const alreadySatisfiedText = "已經符合需求，沒有需要修改的地方。";
export const noChangeInstruction =
  `只有在確認目前的內容已符合所有驗收條件、而且這次不需要修改專案檔案時，才在最後回覆用繁體中文說明判斷依據（例如檔案位置或驗證結果），並在最後一行單獨輸出 ${alreadySatisfiedMark}。如果做不到、無法確認或只符合部分條件，請說明卡在哪裡，不要輸出標記。`;

export function noChangeResult(
  fileCount: number,
  summary: string,
  title: string,
) {
  if (fileCount > 0) return null;
  const lines = summary.trim().split(/\r?\n/);
  if (lines.pop() === alreadySatisfiedMark) {
    const explanation = lines.join("\n").trim();
    if (explanation)
      return {
        answer: `${alreadySatisfiedText}\n\n${clip(explanation, 20000)}`,
        notice: `「${title}」${alreadySatisfiedText}`,
      };
  }
  throw new AppError(
    422,
    `沒有可提交的程式變更，Codex 未確認需求已符合：${clip(summary.trim(), 3000) || "未提供說明"}`,
  );
}
