import { useRef } from "react";

// 看板常在讀取詳情或檢查表單後才開啟視窗，當時的按鈕沒有註冊成 Radix Trigger。
export function useDialogFocus(
  onOpenAutoFocus?: (event: Event) => void,
  onCloseAutoFocus?: (event: Event) => void,
) {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus(event: Event) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement ? active : null;
      onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus(event: Event) {
      onCloseAutoFocus?.(event);
      // 換頁或開啟另一個視窗時，已移到新內容的焦點要留在原處。
      if (event.defaultPrevented || document.activeElement !== document.body)
        return;
      if (opener.current?.isConnected && opener.current !== document.body) {
        event.preventDefault();
        opener.current.focus();
      }
    },
  };
}
