import { parseUpstreamFailure, upstreamFailureText } from "../shared/upstream-failure.js";
import { failureLabels } from "../shared/failure-text.js";

export type FailureEvidence = { detail: string | null; category: string | null };

export function commonFailure(evidence: FailureEvidence[]) {
  if (evidence.length !== 3) return null;
  const failures = evidence.map(({ detail }) => {
    const match = /^([a-z_]+)(?:（HTTP ([1-5]\d\d)）)?$/u.exec(detail ?? "");
    return match && parseUpstreamFailure({ kind: match[1], status: Number(match[2]) });
  });
  if (failures.every((failure) => !failure)) {
    const category = evidence[0].category;
    if (!category || !Object.values(failureLabels).includes(category) || !evidence.every((item) => item.category === category))
      return null;
    return { key: category, reason: category };
  }
  const first = failures[0];
  if (!first || !failures.every((item) => item?.kind === first.kind)) return null;
  const common = failures.every((item) => item?.status === first.status) ? first : { kind: first.kind };
  return { key: first.kind, reason: upstreamFailureText(common) };
}
