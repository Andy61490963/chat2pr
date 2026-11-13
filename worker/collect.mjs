import { collectCandidate } from "./trusted-changes.mjs";

// 伺服器依專案設定算好的排除清單；未提供時不排除任何檔案。
const exclude = process.env.AGENTFLOW_COLLECT_EXCLUDE
  ? JSON.parse(process.env.AGENTFLOW_COLLECT_EXCLUDE)
  : [];

process.stdout.write(JSON.stringify(await collectCandidate({ exclude })));
