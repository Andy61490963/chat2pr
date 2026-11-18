import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * 複製一段文字到剪貼簿，按下後短暫顯示「已複製」；瀏覽器不允許複製時顯示「無法複製」，
 * 讓管理者知道要自己選取文字。結果以 aria-live 告知螢幕報讀器。
 */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => setResult(null), 2000);
    return () => clearTimeout(t);
  }, [result]);
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className={className}
      onClick={() => {
        const clipboard = navigator.clipboard;
        if (!clipboard) return setResult("failed");
        clipboard.writeText(text).then(
          () => setResult("copied"),
          () => setResult("failed"),
        );
      }}
    >
      {result === "copied" ? <Check /> : <Copy />}
      <span aria-live="polite">
        {result === "copied"
          ? "已複製"
          : result === "failed"
            ? "無法複製，請手動選取"
            : label}
      </span>
    </Button>
  );
}
