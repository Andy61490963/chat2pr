export const MAX_CHANGE_FILES: number;
export const MAX_CHANGE_BYTES: number;
export const sourceVersionInstructions: string;
export const changeInstructions: string;
export interface CompiledExclude {
  rule: string;
  directory: boolean;
  anchored: boolean;
  parts: RegExp[];
}
export function compileExcludes(patterns?: string[]): CompiledExclude[];
export function matchExclude(
  file: string,
  rules: CompiledExclude[],
): { rule: string; group: string; directory: boolean } | null;
export function buildOutputHint(file: string): string | null;
export function assertChangeLimits(
  files: Array<{ path: string; bytes: number; added?: boolean }>,
  excluded?: { files: number; bytes: number },
): void;
