import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReportImage } from "../../shared/query-report";
import {
  normalizeReportMarkdown,
  remarkReportSections,
} from "../../shared/query-report";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import "./query-report.css";

function Diagram({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [drawing, setDrawing] = useState<{ url: string; width: number } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let active = true;
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;left:-20000px;top:0;width:2400px;visibility:hidden";
    document.body.append(host);
    setDrawing(null);
    setFailed(false);
    void (async () => {
      // 不接受內嵌設定、互動連結、外部資源或任意圖形種類。
      if (
        source.length > 8000 ||
        !/^\s*(flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/.test(source) ||
        /%%\{|^---|\bclick\b|https?:|url\s*\(|<|@\{/im.test(source)
      )
        throw new Error("圖形超出可呈現範圍");
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        maxTextSize: 8000,
        maxEdges: 50,
        suppressErrorRendering: true,
        flowchart: { htmlLabels: false, useMaxWidth: false },
      });
      const { svg } = await mermaid.render("report" + id, source, host);
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      const box = parsed.documentElement
        .getAttribute("viewBox")
        ?.split(/\s+/)
        .map(Number);
      if (
        !box ||
        box.length !== 4 ||
        !box.every(Number.isFinite) ||
        box[2] <= 0 ||
        box[3] <= 0 ||
        box[2] > 5000 ||
        box[3] > 5000
      )
        throw new Error("圖形尺寸超過限制");
      // 以圖片顯示 SVG，圖形無法在看板文件執行程式或載入互動內容。
      if (active)
        setDrawing({
          url: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg),
          width: box[2],
        });
    })()
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => host.remove());
    return () => {
      active = false;
      host.remove();
    };
  }, [source, id]);
  const controls = (
    <div className="flex flex-wrap gap-2">
      <Button
        size="xs"
        variant="outline"
        disabled={zoom >= 3}
        onClick={() => setZoom(Math.min(3, zoom + 0.25))}
      >
        放大
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={zoom <= 0.5}
        onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
      >
        縮小
      </Button>
      <Button size="xs" variant="outline" onClick={() => setZoom(1)}>
        重設
      </Button>
      <span className="text-xs self-center">{Math.round(zoom * 100)}%</span>
    </div>
  );
  const graphic = drawing && (
    <div
      className="overflow-auto max-h-[70vh] bg-white p-3"
      tabIndex={0}
      aria-label="流程圖，可橫向捲動"
    >
      <img
        src={drawing.url}
        alt="簡易流程圖，說明請見下方文字"
        style={{
          width: drawing.width * zoom,
          maxWidth: "none",
          marginInline: "auto",
        }}
      />
    </div>
  );
  return (
    <div className="my-3 min-w-0 rounded-lg border p-3 space-y-3">
      {failed ? (
        <div role="status">
          <p>流程圖無法顯示，請參考報告的文字說明。</p>
          <details>
            <summary>查看圖形原始內容</summary>
            <pre>{source}</pre>
          </details>
        </div>
      ) : drawing ? (
        <>
          <div className="flex flex-wrap justify-between gap-2">
            {controls}
            <Button
              size="xs"
              variant="outline"
              onClick={() => setExpanded(true)}
            >
              全螢幕
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            圖形可左右捲動，也可全螢幕查看。
          </p>
          {graphic}
        </>
      ) : (
        <p role="status">正在繪製流程圖…</p>
      )}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          className="w-[96vw] max-w-[96vw] sm:max-w-[96vw]"
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            setExpanded(false);
          }}
        >
          <DialogTitle>簡易圖解</DialogTitle>
          <DialogDescription>
            可放大、縮小或橫向捲動查看；按 Esc 關閉。
          </DialogDescription>
          {controls}
          {graphic}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Picture({
  image,
  taskId,
  alt,
}: {
  image?: ReportImage;
  taskId: string;
  alt?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    setExpanded(false);
  }, [image?.id]);
  if (!image || failed)
    return (
      <span className="block rounded border p-3 text-muted-foreground">
        圖片無法提供或已失效：{alt || "補充圖片"}。請參考文字說明。
      </span>
    );
  const url = `/api/tasks/${encodeURIComponent(taskId)}/report-images/${encodeURIComponent(image.id)}`;
  const provenance = `來源：${image.source}${image.capturedAt ? "｜截圖時間：" + new Date(image.capturedAt).toLocaleString("zh-TW") : ""}`;
  return (
    <span className="block my-3">
      <button
        className="block max-w-full cursor-zoom-in"
        onClick={() => setExpanded(true)}
        aria-label={`放大圖片：${image.caption}`}
      >
        <img
          className="max-h-80 rounded border object-contain"
          src={url}
          alt={image.caption}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </button>
      <span className="block text-sm">{image.caption}</span>
      <span className="block text-xs text-muted-foreground">{provenance}</span>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          className="w-[96vw] max-w-[96vw] sm:max-w-[96vw]"
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            setExpanded(false);
          }}
        >
          <DialogTitle>{image.caption}</DialogTitle>
          <DialogDescription>{provenance}</DialogDescription>
          <div className="overflow-auto max-h-[75vh]">
            <img
              className="mx-auto"
              src={url}
              alt={image.caption}
              onError={() => setFailed(true)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </span>
  );
}

const noImages: ReportImage[] = [];
export function QueryReport({
  answer,
  taskId,
  images = noImages,
}: {
  answer: string;
  taskId: string;
  images?: ReportImage[];
}) {
  const [available, setAvailable] = useState(images);
  useEffect(() => {
    setAvailable((previous) =>
      JSON.stringify(previous) === JSON.stringify(images) ? previous : images,
    );
  }, [images]);
  useEffect(() => {
    if (!images.length) return;
    let active = true;
    const check = async () => {
      try {
        const response = await fetch(
          `/api/tasks/${encodeURIComponent(taskId)}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error("來源無法確認");
        const detail = await response.json();
        if (active)
          setAvailable((previous) =>
            JSON.stringify(previous) ===
            JSON.stringify(detail.reportImages ?? [])
              ? previous
              : (detail.reportImages ?? []),
          );
      } catch {
        if (active) setAvailable([]);
      }
    };
    const timer = setInterval(() => void check(), 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [taskId, images.length]);
  // 即時狀態更新時保留圖形與放大視窗，避免重新建立 Markdown 元件而重設互動。
  const components = useMemo<import("react-markdown").Components>(
    () => ({
      p: ({ children }) => <div className="report-paragraph">{children}</div>,
      a: ({ href, children }) =>
        href?.startsWith("/workspace/") ? (
          <code>{href.slice(11)}</code>
        ) : (
          <a
            href={href?.startsWith("report:") ? undefined : href}
            target="_blank"
            rel="noreferrer"
          >
            {children}
          </a>
        ),
      img: ({ src, alt }) => (
        <Picture
          taskId={taskId}
          alt={alt}
          image={available.find((i) => "report:" + i.key === src)}
        />
      ),
      table: ({ children }) => (
        <div className="overflow-x-auto">
          <table>{children}</table>
        </div>
      ),
      pre: ({ children }) => {
        const child = Children.toArray(children)[0];
        if (
          isValidElement<{ className?: string; children?: unknown }>(child) &&
          child.props.className === "language-mermaid"
        )
          return <Diagram source={String(child.props.children ?? "").trim()} />;
        return <pre>{children}</pre>;
      },
    }),
    [taskId, available],
  );
  return (
    <div className="query-report min-w-0 rounded-lg border bg-muted/20 px-4 py-3">
      <Markdown
        remarkPlugins={[remarkGfm, remarkReportSections]}
        skipHtml
        urlTransform={(url) =>
          /^report:[a-zA-Z0-9_-]{1,40}$/.test(url)
            ? url
            : defaultUrlTransform(url)
        }
        components={components}
      >
        {normalizeReportMarkdown(answer)}
      </Markdown>
    </div>
  );
}
