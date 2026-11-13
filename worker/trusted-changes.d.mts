export interface ChangeMetadata {
  bytes: number;
  hash: string;
  mode: string;
}
export interface ChangeEntry {
  path: string;
  before: ChangeMetadata | null;
  after: ChangeMetadata | null;
}
export interface CandidateOptions {
  workspace?: string;
  baseline?: string;
  scratchRoot?: string;
  maxEvidenceBytes?: number;
  /** 已套用專案增減的完整排除清單，語意見 shared/build-output.ts。 */
  exclude?: string[];
}
export interface ExcludedGroup {
  path: string;
  rule: string;
  files: number;
  bytes: number;
}
export interface ExcludedSummary {
  files: number;
  bytes: number;
  totalGroups: number;
  groups: ExcludedGroup[];
}
export const REVIEW_EVIDENCE_BYTES: number;
export function collectCandidate(options?: CandidateOptions): Promise<{
  files: Array<{ path: string; content: string | null; mode: string }>;
  manifest: ChangeEntry[];
  stat: string;
  diff: string;
  diffBytes: number;
  diffTruncated: boolean;
  excluded: ExcludedSummary;
}>;
export function prepareReviewEvidence(
  expected: ChangeEntry[] | undefined,
  options?: CandidateOptions,
): Promise<{
  manifestPath: string;
  complete: true;
  files: Array<{
    path: string;
    binary: boolean;
    before: (ChangeMetadata & { file: string }) | null;
    after: (ChangeMetadata & { file: string }) | null;
    patch: { path: string; bytes: number; hash: string } | null;
  }>;
}>;
