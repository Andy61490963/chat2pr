import {
  containsRepositoryCredential,
  sensitiveRepoPath,
} from "./repository-safety.js";

const escape = (value: string) => value.replace(/[\\`*_{}\[\]()<>!|]/g, "\\$&");
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** 僅呈現已提交的附件，不把檔案存在誤稱為已完成視覺驗收。 */
export function prEvidence(
  repo: string,
  sha: string,
  paths: string[],
  sensitivePaths: string[] = [],
) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    !/^[a-f0-9]{40}$/.test(sha)
  )
    throw new Error("驗收附件的儲存庫或提交版本不合法");
  const candidates = [...new Set(paths)].filter(
    (path) =>
      path.length <= 400 &&
      !/[\x00-\x1f\x7f\\]/.test(path) &&
      !path.startsWith("/") &&
      !path.split("/").some((x) => x === ".." || x === "." || !x) &&
      !sensitiveRepoPath(path, sensitivePaths) &&
      !containsRepositoryCredential(path),
  );
  const url = (path: string) =>
    `https://github.com/${repo}/blob/${sha}/${path.split("/").map(encode).join("/")}`;
  const images = candidates
    .filter((p) =>
      /^(?:docs|screenshots|artifacts)\/.*\.(?:png|jpe?g|webp|gif)$/i.test(p),
    )
    .sort();
  const docs = candidates.filter((p) => /^docs\/.*\.md$/i.test(p)).sort();
  if (!images.length && !docs.length) return "";
  const parts = [
    "## 圖片與驗收附件",
    "以下附件來自本次提交；資料來源、測試方式與限制請參閱驗收文件。",
  ];
  const preview = images.slice(0, 8),
    shown = new Set<string>();
  const image = (p: string) => `![${escape(p)}](${url(p)}?raw=true)`;
  for (const path of preview) {
    if (shown.has(path)) continue;
    const match = path.match(/^(.*?)([._-])(before|after)([._-].*)$/i);
    const counterpart =
      match &&
      preview.find(
        (p) =>
          p.toLowerCase() ===
          `${match[1]}${match[2]}${match[3].toLowerCase() === "before" ? "after" : "before"}${match[4]}`.toLowerCase(),
      );
    if (match && counterpart) {
      const before = match[3].toLowerCase() === "before" ? path : counterpart;
      const after = before === path ? counterpart : path;
      parts.push(
        `### ${escape(match[1] + match[4])}`,
        `| 修改前 | 修改後 |\n| --- | --- |\n| ${image(before)} | ${image(after)} |`,
      );
      shown.add(counterpart);
    } else {
      parts.push(image(path));
    }
    shown.add(path);
  }
  if (images.length > 8)
    parts.push(
      `圖片共 ${images.length} 張，內嵌預覽前 8 張，其餘請由附件連結或 Files changed 查看。`,
    );
  const links = [...docs, ...images].slice(0, 32);
  if (links.length)
    parts.push(
      "### 附件連結",
      links.map((p) => `- [${escape(p)}](${url(p)})`).join("\n"),
    );
  if (docs.length + images.length > links.length)
    parts.push("附件超過 32 份，其餘請至 Files changed 查看。");
  let result = "";
  for (const part of parts) {
    if (result.length + part.length > 24000)
      return result + "\n\n附件較多，其餘請至 Files changed 查看。";
    result += (result ? "\n\n" : "") + part;
  }
  return result;
}
