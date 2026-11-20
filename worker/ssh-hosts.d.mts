export interface SshHost {
  name: string;
  host: string;
  port: number;
  username: string;
  note?: string;
  hostKey?: string | null;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}
export function parseHosts(raw: string | undefined): SshHost[];
export function fingerprintOf(base64Key: string): string;
export function matchingKnownHost(
  scan: string,
  hostKey: string,
): string | undefined;
export function commonOptions(
  host: SshHost,
  knownHosts: string,
  pinned: boolean,
): string[];
export function sshArgs(
  host: SshHost,
  options: string[],
  keyFile: string | undefined,
  command: string[],
): string[];
export function scpArgs(
  host: SshHost,
  options: string[],
  keyFile: string | undefined,
  paths: string[],
): string[];
export function describe(hosts: SshHost[]): string;
