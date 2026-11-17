/**
 * 排程工作動作的第一個執行檔是否會開出可見的主控台視窗。
 * 直接執行 node.exe、cloudflared.exe 等主控台程式時會有視窗，被關掉就連同子程序一起結束；
 * 經 conhost.exe --headless 執行則沒有視窗。
 */
export function opensConsoleWindow(action) {
  const text = String(action ?? "").trim();
  const first = /^"?([^"]*?\.exe)\b"?\s*(.*)$/i.exec(text);
  if (!first) return false;
  const exe = first[1].split(/[\\/]/).pop().toLowerCase();
  if (exe === "conhost.exe") return !/(^|\s)--headless(\s|$)/i.test(first[2]);
  return ["node.exe", "cloudflared.exe", "cmd.exe"].includes(exe);
}
