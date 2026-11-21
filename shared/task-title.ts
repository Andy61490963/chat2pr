const followupTitleLimit = 60;
const followupPrefix = /^(追問：|追加：)/;
const singleLine = (text: string) => text.trim().replace(/\s+/g, " ");

export function shortFollowupTitle(prefix: string, text: string) {
  const characters = Array.from(singleLine(text));
  return characters.length > followupTitleLimit
    ? prefix + characters.slice(0, followupTitleLimit).join("").trimEnd() + "…"
    : prefix + characters.join("");
}

export function fullTaskTitle(title: string, summary: string) {
  const prefix = followupPrefix.exec(title)?.[0];
  if (!prefix) return title;
  const text = singleLine(summary);
  const full = prefix + text;
  const short = shortFollowupTitle(prefix, text);
  // 舊版以 UTF-16 截短，且沒有加省略號。
  const legacy = prefix + text.slice(0, followupTitleLimit);
  return title === short || title === legacy ? full : title;
}

export function taskListTitle(
  task: { title: string; summary: string },
  full = fullTaskTitle(task.title, task.summary),
) {
  return full !== task.title && !task.title.endsWith("…")
    ? task.title.trimEnd() + "…"
    : task.title;
}
