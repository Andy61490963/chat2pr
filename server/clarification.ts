import { z } from "zod";
import type { TriageDecision } from "../shared/types.js";
import { withAssumptions } from "../shared/clarification.js";
import { redact } from "./policy.js";

export const Question = z
  .object({
    text: z.string().trim().min(1).max(240),
    choices: z.array(z.string().trim().min(1).max(120)).max(3),
  })
  .strict();
export const Assumptions = z.array(z.string().trim().min(1).max(500)).max(8);

/** 所有判讀入口共用，避免模型仍輸出舊版開發方案或有問題卻自動派工。 */
export function clarifyDecision(d: TriageDecision) {
  const adjustments: string[] = [];
  d.assumptions = [...new Set((d.assumptions ?? []).map(redact))];
  d.question = d.question
    ? {
        text: redact(d.question.text),
        choices: d.question.choices.map(redact),
      }
    : null;
  if (!["request", "clarification"].includes(d.kind)) {
    d.question = null;
    d.assumptions = [];
    d.suggestions = [];
    return adjustments;
  }
  const discardedOptions = d.taskType === "query" && d.suggestions.length > 0;
  if (d.suggestions.length && (d.taskType === "query" || d.question)) {
    adjustments.push(
      d.taskType === "query" ? "移除查詢的開發方案" : "保留問題並移除方案",
    );
    d.suggestions = [];
  }
  if (d.suggestions.length > 3) {
    d.suggestions = d.suggestions.slice(0, 3);
    adjustments.push("方案保留前三項");
  }
  if (d.suggestions.length === 1) {
    // 單一方向不代表使用者同意，轉成問題而不自動採用為假設。
    d.question = {
      text: `是否照這個方向處理：${redact(d.suggestions[0].label)}？`,
      choices: ["是", "需要調整"],
    };
    d.suggestions = [];
    adjustments.push("單一方案改為確認問題");
  }
  if (d.suggestions.length) {
    if (d.suggestions.filter((s) => s.recommended).length !== 1) {
      const first = Math.max(
        0,
        d.suggestions.findIndex((s) => s.recommended),
      );
      d.suggestions = d.suggestions.map((s, index) => ({
        ...s,
        recommended: index === first,
      }));
      adjustments.push("保留第一個推薦，沒有推薦則選第一項");
    }
    if (d.suggestions.some((s) => !s.reason?.trim())) {
      d.suggestions = d.suggestions.map((s) => ({
        ...s,
        reason: s.reason?.trim() || "AI 未說明理由",
      }));
      adjustments.push("補上未提供理由的提示");
    }
  }
  if (
    !d.question &&
    !d.suggestions.length &&
    (d.kind === "clarification" || d.missing.length || discardedOptions)
  ) {
    d.question = {
      text: redact(d.missing[0] || "你希望這次處理的具體問題是什麼？").slice(
        0,
        240,
      ),
      choices: [],
    };
  }
  if (d.question) {
    d.kind = "clarification";
    d.missing = [...new Set([...d.missing, d.question.text])];
  }
  d.summary = withAssumptions(d.summary, d.assumptions, d.assumptions);
  return adjustments;
}
