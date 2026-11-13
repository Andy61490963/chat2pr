/** 索引範圍只接受相對檔案路徑或目錄前綴，不接受路徑跳脫與萬用字元。 */
export function validIndexPath(path: string) {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    path === path.trim() &&
    !path.startsWith("/") &&
    !/[\\:*?\[\]{}\u0000-\u001f\u007f]/u.test(path) &&
    !/[@+!]\(/u.test(path) &&
    !path.split("/").some((part) => !part || part === "." || part === "..")
  );
}

export function indexPathsFromForm(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean)
        // 先排除真正的空白行，再去除目錄尾斜線；「/」必須保留為無效項目。
        .map((value) => value.replace(/\/$/, "")),
    ),
  ].sort();
}
