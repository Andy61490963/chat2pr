import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Pending = { proceed: () => void; cancel?: () => void };
type Guard = (
  proceed: () => void,
  options?: {
    /** 只檢查這些開頭的表單；不給就檢查全部。 */
    prefixes?: string[];
    /** 使用者選擇繼續編輯時要做的事（例如把網址改回來）。 */
    cancel?: () => void;
  },
) => void;

const Unsaved = createContext<{
  mark: (key: string, dirty: boolean) => void;
  guard: Guard;
}>({ mark: () => {}, guard: (proceed) => proceed() });

// 表單有還沒儲存的修改時，關閉側邊欄、換頁或重新整理前先問一次，不再無聲丟掉。
export function UnsavedProvider({ children }: { children: ReactNode }) {
  const dirty = useRef(new Set<string>());
  const [pending, setPending] = useState<Pending | null>(null);
  const mark = useCallback((key: string, on: boolean) => {
    if (on) dirty.current.add(key);
    else dirty.current.delete(key);
  }, []);
  const guard = useCallback<Guard>((proceed, options) => {
    const hit = [...dirty.current].some(
      (k) =>
        !options?.prefixes || options.prefixes.some((p) => k.startsWith(p)),
    );
    if (hit) setPending({ proceed, cancel: options?.cancel });
    else proceed();
  }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!dirty.current.size) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const value = useMemo(() => ({ mark, guard }), [mark, guard]);
  const stay = () => {
    pending?.cancel?.();
    setPending(null);
  };
  return (
    <Unsaved.Provider value={value}>
      {children}
      <Dialog open={!!pending} onOpenChange={(o) => !o && stay()}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>放棄未儲存的修改？</DialogTitle>
            <DialogDescription>
              你有修改還沒儲存。現在離開，這些修改不會保留。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={stay}>
              繼續編輯
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const next = pending?.proceed;
                setPending(null);
                next?.();
              }}
            >
              放棄修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Unsaved.Provider>
  );
}

/** 表單回報自己有沒有未儲存的修改；元件卸載時自動清除。 */
export function useUnsaved(key: string, dirty: boolean) {
  const { mark } = useContext(Unsaved);
  useEffect(() => {
    mark(key, dirty);
    return () => mark(key, false);
  }, [key, dirty, mark]);
}

/** 離開前檢查：沒有未儲存的修改就直接做，有的話先問使用者。 */
export const useGuard = () => useContext(Unsaved).guard;
