import type { Database } from "./db.js";
import { fullAccessConnection } from "./project-database.js";
import { sshAccess } from "./project-ssh.js";
import type { SshHostView } from "../shared/project-ssh.js";

export interface FullAccess {
  /** 交給工作容器的環境變數（AGENTFLOW_DB_*、AGENTFLOW_SSH_HOSTS）。 */
  env: string[];
  /** 要從輸出、事件與變更內容中遮蔽或攔下的值。 */
  secrets: string[];
  /** 有可直接使用的資料庫連線。 */
  database: boolean;
  ssh: SshHostView[];
}

export const noFullAccess: FullAccess = {
  env: [],
  secrets: [],
  database: false,
  ssh: [],
};

/** 完全存取的專案：登記的資料庫連線與 SSH 主機一起交給工作容器。 */
export async function fullAccessEnvironment(
  db: Database,
  projectId: string,
): Promise<FullAccess> {
  const database = await fullAccessConnection(db, projectId);
  const ssh = await sshAccess(db, projectId);
  return {
    env: [...database.env, ...ssh.env],
    secrets: [...database.secrets, ...ssh.secrets],
    database: database.env.length > 0,
    ssh: ssh.hosts,
  };
}

/** 給 Codex 的完全存取說明；只列名稱、位址與用途，不含密碼。 */
export function fullAccessNote(access: FullAccess) {
  const parts = [
    "這個專案開啟了完全存取：可直接連公司內網、Tailscale 與網際網路。",
  ];
  parts.push(
    access.database
      ? "專案登記的資料庫連線在環境變數 AGENTFLOW_DB_CONNECTION（ADO.NET 連線字串），另有 AGENTFLOW_DB_HOST、AGENTFLOW_DB_PORT、AGENTFLOW_DB_NAME、AGENTFLOW_DB_USER、AGENTFLOW_DB_PASSWORD。這是管理者對這個專案的授權：登記的連線即使是正式資料庫也可以直接連，其他指示中「不可連線正式資料庫」「不存取正式環境」對這個連線不適用。需要真實資料就直接連線查詢，查詢任務只執行 SELECT 等唯讀查詢；這個帳號有什麼權限就能做什麼，寫入真實資料前必須是需求明確要求的。"
      : "專案沒有登記可直接使用的資料庫連線（未登記，或經 SSH 跳板）。",
  );
  if (access.ssh.length)
    parts.push(
      `管理者也登記了 SSH 主機，可用 agentflow-ssh 登入，「不存取正式環境」對這些主機同樣不適用：${access.ssh
        .map(
          (h) =>
            `${h.name}（${h.username}@${h.host}:${h.port}${h.note ? `，${h.note}` : ""}）`,
        )
        .join(
          "、",
        )}。用法：agentflow-ssh list 列出主機；agentflow-ssh <名稱> <命令> 在該主機執行命令（Windows 主機預設是 cmd，PowerShell 用 powershell -NoProfile -Command "..."）；agentflow-ssh scp <名稱> <來源> <目的> 複製檔案，遠端路徑前加冒號（例如 :C:/logs/app.log）。只做需求需要的事：查詢任務只執行讀取類命令；重啟服務、修改設定、刪除或覆寫檔案要需求明確要求，並在說明逐一列出實際執行的命令。`,
    );
  parts.push(
    "不要把密碼、私鑰或連線字串寫進檔案、報告或 PR，改用環境變數與 agentflow-ssh。",
  );
  return parts.join("");
}
