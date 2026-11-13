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
}
export const REVIEW_EVIDENCE_BYTES: number;
export function collectCandidate(options?: CandidateOptions): Promise<{
  files: Array<{ path: string; content: string | null; mode: string }>;
  manifest: ChangeEntry[];
  stat: string;
  diff: string;
  diffBytes: number;
  diffTruncated: boolean;
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
