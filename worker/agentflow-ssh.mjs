#!/usr/bin/env node
// 完全存取專案的 SSH 工具：用管理者在看板登記的主機與帳密登入，密碼與私鑰不出現在命令列。
//   agentflow-ssh list
//   agentflow-ssh <名稱> <命令...>
//   agentflow-ssh scp <名稱> <來源...> <目的>（遠端路徑前加冒號）
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  commonOptions,
  describe,
  matchingKnownHost,
  parseHosts,
  scpArgs,
  sshArgs,
} from "./ssh-hosts.mjs";

const usage = `用法：
  agentflow-ssh list
  agentflow-ssh <名稱> <命令...>
  agentflow-ssh scp <名稱> <來源...> <目的>   遠端路徑前加冒號，例如 :C:/logs/app.log`;

const fail = (text, code = 2) => {
  process.stderr.write(`${text}\n`);
  process.exit(code);
};

let hosts;
try {
  hosts = parseHosts(process.env.AGENTFLOW_SSH_HOSTS);
} catch {
  fail("讀不到登記的 SSH 主機。");
}
const args = process.argv.slice(2);
if (!args.length || args[0] === "list" || args[0] === "--help") {
  process.stdout.write(`${describe(hosts)}\n${args.length ? "" : usage}\n`);
  process.exit(0);
}
const copy = args[0] === "scp";
const name = copy ? args[1] : args[0];
const rest = args.slice(copy ? 2 : 1);
const host = hosts.find((h) => h.name === name);
if (!host)
  fail(`沒有名為 ${name ?? ""} 的主機。登記的主機：\n${describe(hosts)}`);
if (!rest.length || (copy && rest.length < 2)) fail(usage);

const dir = "/tmp/agentflow-ssh";
mkdirSync(dir, { recursive: true, mode: 0o700 });
const knownHosts = `${dir}/known_hosts-${host.name}`;
// 看板測試登入時記下的主機金鑰：只信任和它相同的金鑰，避免連到被冒充的主機。
if (host.hostKey) {
  const scan = spawnSync(
    "ssh-keyscan",
    ["-T", "10", "-p", String(host.port), host.host],
    { encoding: "utf8" },
  );
  const line = matchingKnownHost(scan.stdout ?? "", host.hostKey);
  if (!line)
    fail(
      `${host.name} 的主機金鑰和看板登記時不同（或連不到主機），已停止連線。`,
      255,
    );
  writeFileSync(knownHosts, `${line}\n`, { mode: 0o600 });
}
let keyFile;
if (host.privateKey) {
  keyFile = `${dir}/${host.name}.key`;
  writeFileSync(
    keyFile,
    host.privateKey.endsWith("\n") ? host.privateKey : `${host.privateKey}\n`,
    { mode: 0o600 },
  );
}
const options = commonOptions(host, knownHosts, !!host.hostKey);
const toolArgs = copy
  ? scpArgs(host, options, keyFile, rest)
  : sshArgs(host, options, keyFile, rest);
const tool = copy ? "scp" : "ssh";
// 密碼或私鑰的密碼片語由 sshpass 從環境變數 SSHPASS 送出，不會出現在命令列或程序清單。
const secret = host.privateKey ? host.passphrase : host.password;
const [cmd, cmdArgs] = secret
  ? [
      "sshpass",
      [
        ...(host.privateKey ? ["-P", "passphrase"] : []),
        "-e",
        tool,
        ...toolArgs,
      ],
    ]
  : [tool, toolArgs];
const child = spawn(cmd, cmdArgs, {
  stdio: "inherit",
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? "/tmp/home",
    ...(secret ? { SSHPASS: secret } : {}),
  },
});
child.on("exit", (code, signal) => process.exit(signal ? 255 : (code ?? 255)));
child.on("error", () => fail(`無法執行 ${cmd}`, 255));
