/** 專案登記的 SSH 主機（看板顯示用）；密碼與私鑰只寫入，不回傳。 */
export interface SshHostView {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: "password" | "key";
  note: string;
  /** 第一次測試登入成功時記下的主機金鑰指紋；沒有代表還沒測試過。 */
  hostKey: string | null;
  updatedAt: string;
}

export interface SshTestResult {
  ok: boolean;
  detail: string;
}

/** 名稱給 Codex 在容器裡用（agentflow-ssh <名稱> <命令>），限英數與 . _ -。 */
export const sshHostNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const maxSshHosts = 20;
