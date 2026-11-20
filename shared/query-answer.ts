/** 舊答案與待送通知曾帶固定的查詢標頭。只辨認系統格式，保留報告本身引用的版本。 */
export function splitQueryAnswer(text: string) {
  const match =
    /^(?<envelope>「[^\n]*」的查詢結果：\r?\n\r?\n)?(?<source>查詢專案：[^\n]+\r?\n基底分支：[^\n]*；查詢版本：[^\n]*(?:\r?\n(?:一併查詢|延續)：[^\n]*)*)\r?\n*/.exec(
      text,
    );
  return match?.groups
    ? {
        body: (match.groups.envelope ?? "") + text.slice(match[0].length),
        source: match.groups.source,
      }
    : { body: text, source: null };
}
