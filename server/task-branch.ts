import { z } from "zod";
import type { Message, Project, TriageDecision } from "../shared/types.js";
import {
  validTargetBranch,
  type BranchCatalog,
  type TaskBranchSelection,
} from "../shared/task-branch.js";

export const TargetBranch = z
  .string()
  .refine(validTargetBranch, "請輸入有效的 Git 分支名稱");
export const BranchChoice = z
  .object({
    name: z.string().max(200).nullable(),
    basis: z.enum(["default", "explicit", "uncertain"]),
    reason: z.string().min(1).max(1000),
    evidence: z
      .array(
        z
          .object({
            sourceId: z.string().max(1000),
            quote: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();

export function assessBranch(
  d: TriageDecision,
  project: Project | undefined,
  messages: Message[],
  catalog?: BranchCatalog,
) {
  const result = (
    name: string | null,
    basis: TaskBranchSelection["basis"],
    reason: string,
    sourceIds: string[] = [],
  ) => ({
    name,
    automatic: basis === "default" || basis === "explicit",
    selection: { basis, reason, sourceIds },
  });
  if (!project)
    return result(null, "uncertain", "請先選擇專案，再確認目標分支");
  const roots = messages.filter(
    (m) => !m.contextOnly && d.sourceIds.includes(m.id),
  );
  const mentions = (text: string, name: string) =>
    new RegExp(
      `(?<![A-Za-z0-9_/.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_/.-])`,
      "u",
    ).test(text);
  const names = catalog?.names ?? [project.base_branch];
  const named = names.filter((name) =>
    roots.some((m) => mentions(m.text ?? "", name)),
  );
  const branchWords = roots.some((m) =>
    /分支|\bbranch\b|refs\/heads\/|主線|主幹/iu.test(m.text ?? ""),
  );
  const parsed = BranchChoice.safeParse(d.targetBranch);
  // 舊版判讀資料只可沿用沒有分支指示的專案預設，不能把未知指示默默降級。
  const choice = parsed.success
    ? parsed.data
    : {
        name: project.base_branch,
        basis: "default",
        reason: "需求未指定分支，使用專案預設分支",
        evidence: [],
      };
  const selected =
    choice.name && validTargetBranch(choice.name) && names.includes(choice.name)
      ? choice.name
      : null;
  if (!selected)
    return result(
      null,
      "uncertain",
      `無法確認目標分支${choice.name ? `「${choice.name}」` : ""}，請從 GitHub 選擇實際分支`,
    );
  if (choice.basis === "uncertain")
    return result(selected, "uncertain", choice.reason);
  if (named.length > 1)
    return result(
      selected,
      "uncertain",
      "需求涉及多個分支，請確認這次讀取及 PR 的目標分支",
    );
  if (choice.basis === "default") {
    if (
      branchWords ||
      named.some((n) => n !== project.base_branch) ||
      selected !== project.base_branch
    )
      return result(
        selected,
        "uncertain",
        `需求提到分支或主線，請確認目前建議的「${selected}」，不會自動當成專案預設分支`,
      );
    return result(
      selected,
      "default",
      `使用專案預設分支「${selected}」；這筆任務已固定分支，不會跟隨其他任務變更`,
    );
  }
  const evidence = choice.evidence;
  const valid =
    !!catalog &&
    evidence.length > 0 &&
    evidence.every(
      (e) =>
        roots.some((m) => m.id === e.sourceId && m.text?.includes(e.quote)) &&
        mentions(e.quote, selected),
    );
  if (!valid || named.length !== 1)
    return result(
      selected,
      "uncertain",
      "分支引用不足或不是本次需求，請人工確認",
    );
  if (selected !== project.base_branch && d.routing?.basis !== "explicit")
    return result(
      selected,
      "uncertain",
      "候選程式證據來自專案預設分支，不能代替其他分支的專案與內容確認",
    );
  return result(
    selected,
    "explicit",
    choice.reason,
    evidence.map((e) => e.sourceId),
  );
}
