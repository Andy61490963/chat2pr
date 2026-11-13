export const ENVIRONMENT_MARK: string;
export const ENVIRONMENT_EXIT: number;
export const SERVER: string;
export function rewriteLocalDb(
  text: string,
  password: string,
): { text: string; count: number; databases: string[] };
export function findLocalDbFiles(root: string): string[];
export function restoreFiles(root: string, state: string): string[];
export function redirectFiles(
  root: string,
  state: string,
  password: string,
): { files: string[]; databases: string[] };
