export interface ReportImage {
  id: string;
  key: string;
  caption: string;
  kind: "message" | "repository" | "screenshot";
  source: string;
  capturedAt: string | null;
}

type ReportNode = {
  type: string;
  depth?: number;
  value?: string;
  children?: ReportNode[];
  data?: { hName: string; hProperties?: Record<string, string> };
};

/** 以 Markdown 語法樹分段，避免把程式碼內的標題誤當章節，並保留跨段引用。 */
export function remarkReportSections() {
  return (tree: ReportNode) => {
    const output: ReportNode[] = [];
    let section: ReportNode | undefined;
    let hasOverview = false;
    const text = (node: ReportNode): string =>
      node.value ?? node.children?.map(text).join("") ?? "";
    for (const node of tree.children ?? []) {
      if (node.type === "heading" && node.depth === 2) {
        section = undefined;
        const title = text(node).trim();
        const label =
          title === "詳細資訊"
            ? "展開詳細說明"
            : title === "程式依據"
              ? "查看程式依據"
              : undefined;
        if (label && hasOverview) {
          section = {
            type: "reportSection",
            data: {
              hName: "details",
              hProperties: { className: "report-details" },
            },
            children: [
              {
                type: "paragraph",
                data: { hName: "summary" },
                children: [{ type: "text", value: label }],
              },
            ],
          };
          output.push(section);
          continue;
        }
      }
      (section?.children ?? output).push(node);
      if (node.type !== "heading" && node.type !== "definition")
        hasOverview = true;
    }
    tree.children = output;
  };
}

/** 中文標點緊貼粗體邊界時補空白；保留程式碼內容，避免 CommonMark 顯示原始星號。 */
export function normalizeReportMarkdown(answer: string) {
  return answer.replace(
    /(`{3}[\s\S]*?`{3}|~{3}[\s\S]*?~{3}|`[^`\n]*`)|\*\*([^*\n]+)\*\*/g,
    (match, code: string | undefined, text: string | undefined) =>
      code ?? (text ? " **" + text + "** " : match),
  );
}
