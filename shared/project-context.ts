/** 專案補充資料不是憑證儲存庫，也不會自動寫入 Git。 */
export const contextFields = {
  purpose: { label: "專案用途", hint: "這個專案做什麼、與其他系統的關係" },
  branches: {
    label: "分支說明",
    hint: "正式、開發與測試分支的用途；不會自動更換目標分支",
  },
  environment: {
    label: "環境與相依服務",
    hint: "SDK、資料庫、Redis、網路需求與環境名稱；不要填帳密",
  },
  testing: {
    label: "測試準備",
    hint: "建庫腳本、去識別化資料來源、測試步驟與預期結果",
  },
  constraints: {
    label: "操作限制",
    hint: "哪些環境只能讀、禁止操作、需要先確認的事項",
  },
  notes: {
    label: "其他補充與回覆",
    hint: "AI 補問的回答會保留在這裡，可整理或刪除過期資訊",
  },
} as const;
export type ProjectContext = Record<keyof typeof contextFields, string>;
export const emptyContext: ProjectContext = {
  purpose: "",
  branches: "",
  environment: "",
  testing: "",
  constraints: "",
  notes: "",
};
export interface InputQuestion {
  kind: "information" | "authentication";
  question: string;
}
export interface ProjectInputRequest {
  id: string;
  configVersion: number;
  reason: string;
  details?: string;
  questions: InputQuestion[];
  createdAt: string;
}
