import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ExternalLink,
  ImageOff,
  Loader2,
  MessageSquare,
  Settings2,
} from "lucide-react";
import type { ChatMessage, ChatPage } from "../../shared/chat.js";
import { statusLabels } from "../../shared/types.js";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type Request,
  type State,
  date,
  Empty,
  Initials,
  message,
  StatusIcon,
  writeQuery,
} from "./shared";

export function ChatView({
  state,
  request,
  open,
  settings,
}: {
  state: State;
  request: Request;
  open: (id: string) => void;
  settings: () => void;
}) {
  // 正在看的聊天室放在網址，重新整理或分享連結都回到同一間。
  const fromUrl = () =>
    new URLSearchParams(location.search).get("group") ??
    state.groups[0]?.id ??
    "";
  const [selected, setSelected] = useState(fromUrl);
  const group = state.groups.find((g) => g.id === selected) ?? state.groups[0];
  const first = state.groups[0]?.id ?? "";
  useEffect(() => {
    if (group) writeQuery([["group", group.id, first]]);
  }, [group, first]);
  useEffect(() => {
    const onPop = () => setSelected(fromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {!group ? (
        <Card>
          <Empty icon={<MessageSquare />} title="還沒有聊天室">
            把機器人加入群組，傳送訊息後即可查看。
          </Empty>
        </Card>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <Select value={group.id} onValueChange={setSelected}>
              <SelectTrigger aria-label="選擇聊天室" className="w-full sm:w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {state.groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Badge variant={group.enabled ? "secondary" : "outline"}>
              {!group.enabled
                ? "派工已停用"
                : group.trigger_mode === "command"
                  ? "指令與引用追問"
                  : "自動辨識"}
            </Badge>
            <Button variant="ghost" size="sm" onClick={settings}>
              <Settings2 />
              設定觸發方式
            </Button>
          </div>
          <Timeline
            key={group.id}
            groupId={group.id}
            state={state}
            request={request}
            open={open}
          />
        </>
      )}
    </div>
  );
}

function Timeline({
  groupId,
  state,
  request,
  open,
}: {
  groupId: string;
  state: State;
  request: Request;
  open: (id: string) => void;
}) {
  const [rows, setRows] = useState<ChatMessage[]>([]),
    [pages, setPages] = useState(1),
    [next, setNext] = useState<string | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [preview, setPreview] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null),
    listRef = useRef<HTMLOListElement>(null),
    jumped = useRef(false),
    anchor = useRef<{ id: string; top: number } | null>(null);
  // 到期會立即經 API 遮罩；定時刷新也涵蓋沒有新訊息的聊天室。
  useEffect(() => {
    const t = setInterval(() => setRefresh((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        let before: string | null = null;
        const all: ChatMessage[] = [];
        for (let i = 0; i < pages; i++) {
          const data: ChatPage = await request(
            `/api/groups/${encodeURIComponent(groupId)}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`,
          );
          if (!active) return;
          all.unshift(...data.messages);
          before = data.next;
          if (!before) break;
        }
        if (active) {
          // 更新前記住正在看的訊息；前插舊訊息、撤回與定時刷新都不搶閱讀位置。
          const viewport = scrollRef.current?.getBoundingClientRect();
          const visible =
            viewport &&
            Array.from(listRef.current?.children ?? []).find(
              (item) => item.getBoundingClientRect().bottom > viewport.top,
            );
          anchor.current = visible
            ? { id: visible.id, top: visible.getBoundingClientRect().top }
            : null;
          setRows(all);
          setNext(before);
          setError("");
        }
      } catch (e) {
        if (active) {
          setError(message(e));
          setRows([]);
          setPreview(null);
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [groupId, request, pages, state, refresh]);
  // 像一般聊天軟體一樣，打開或切換群組時直接停在最新訊息；之後的刷新與載入更早訊息不搶捲動位置。
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport || !rows.length) return;
    if (!jumped.current) {
      jumped.current = true;
      viewport.scrollTop = viewport.scrollHeight;
    } else if (anchor.current) {
      const item = document.getElementById(anchor.current.id);
      if (item && listRef.current?.contains(item))
        viewport.scrollTop +=
          item.getBoundingClientRect().top - anchor.current.top;
    }
    anchor.current = null;
  }, [rows, groupId]);
  const shown = rows.find((m) => m.id === preview && m.has_image);
  return (
    <>
      <Card className="min-h-0 flex-1 gap-0 overflow-hidden py-0">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3 text-xs text-muted-foreground">
          <span>
            原文與圖片保留 {state.settings.retention_days} 天 ·
            無法補抓機器人加入前的歷史
          </span>
          <span>成員名稱取自 LINE，查不到時顯示代號</span>
        </div>
        <div
          ref={scrollRef}
          role="region"
          aria-label="聊天室訊息捲動區"
          tabIndex={0}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
        >
          {loading && !rows.length && (
            <p className="flex items-center gap-2 p-5 text-sm">
              <Loader2 className="size-4 animate-spin" />
              載入對話中…
            </p>
          )}
          {error && (
            <div role="alert" className="p-4 text-sm text-danger">
              {error}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRefresh((n) => n + 1)}
              >
                重試
              </Button>
            </div>
          )}
          {!loading && !error && !rows.length && (
            <Empty icon={<MessageSquare />} title="還沒有收到訊息">
              這個群組的新訊息會自動出現在這裡。
            </Empty>
          )}
          {next && (
            <Button
              variant="ghost"
              className="m-3"
              disabled={loading}
              onClick={() => {
                setLoading(true);
                setPages((n) => n + 1);
              }}
            >
              <ArrowUp />
              載入更早訊息
            </Button>
          )}
          <ol
            ref={listRef}
            aria-label="群組訊息"
            className="space-y-5 p-4 md:p-6"
          >
            {rows.map((m) => (
              <li key={m.id} id={`chat-${m.id}`} className="flex min-w-0 gap-3">
                <Initials
                  name={m.sender ?? "群組成員"}
                  className="mt-0.5 size-8 text-xs"
                />
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {m.sender ?? "群組成員"}
                    </span>
                    <time dateTime={m.received_at}>{date(m.received_at)}</time>
                    {!m.revoked && !m.expired && (
                      <span>
                        {m.tasks.length
                          ? "已連結任務"
                          : m.routing === "chat"
                            ? "一般聊天・不派工"
                            : m.routing === "pending"
                              ? "等待辨識"
                              : "已辨識"}
                      </span>
                    )}
                  </div>
                  <div className="w-fit max-w-full space-y-2 rounded-xl rounded-tl-sm border bg-muted/40 px-3.5 py-3 sm:max-w-[85%]">
                    {m.revoked || m.expired ? (
                      <p className="text-sm text-muted-foreground">
                        {m.revoked ? "此訊息已撤回" : "原文已到期"}
                      </p>
                    ) : (
                      <>
                        {m.quoted_id && (
                          <p className="rounded-md border-l-2 border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
                            {m.quoted_text ? (
                              <>
                                <span className="font-medium">
                                  回覆 {m.quoted_sender ?? "成員"}：
                                </span>
                                <span className="line-clamp-2 [overflow-wrap:anywhere]">
                                  {m.quoted_text}
                                </span>
                              </>
                            ) : (
                              "回覆一則已撤回、到期或較早的訊息"
                            )}
                            {rows.some((r) => r.id === m.quoted_id) && (
                              <a
                                href={`#chat-${m.quoted_id}`}
                                onClick={(event) => {
                                  const viewport = scrollRef.current;
                                  const target = document.getElementById(
                                    `chat-${m.quoted_id}`,
                                  );
                                  if (
                                    viewport &&
                                    target &&
                                    listRef.current?.contains(target)
                                  ) {
                                    event.preventDefault();
                                    viewport.scrollTop +=
                                      target.getBoundingClientRect().top -
                                      viewport.getBoundingClientRect().top;
                                  }
                                }}
                                className="mt-0.5 block underline"
                              >
                                跳到那則訊息
                              </a>
                            )}
                          </p>
                        )}
                        {m.text && (
                          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
                            {m.text}
                          </p>
                        )}
                        {m.has_image ? (
                          <button
                            aria-label="放大圖片"
                            onClick={() => setPreview(m.id)}
                            className="block rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            <img
                              loading="lazy"
                              className="max-h-64 max-w-full rounded-lg object-contain"
                              src={`/api/messages/${encodeURIComponent(m.id)}/image`}
                              alt="LINE 群組圖片"
                            />
                          </button>
                        ) : m.type === "image" ? (
                          <p className="flex items-center gap-2 text-sm text-muted-foreground">
                            <ImageOff className="size-4" />
                            {m.image_state === "failed"
                              ? "圖片無法取得（下載重試已結束）"
                              : "圖片下載中…"}
                          </p>
                        ) : (
                          m.type !== "text" && (
                            <p className="text-sm text-muted-foreground">
                              {m.type === "sticker"
                                ? "貼圖（不提供預覽）"
                                : "附件（不支援預覽）"}
                            </p>
                          )
                        )}
                      </>
                    )}
                  </div>
                  {!!m.tasks.length && (
                    <div className="mt-2 flex flex-col items-start gap-1.5">
                      {m.tasks.map((t) => (
                        <button
                          key={t.id}
                          className="flex max-w-full items-center gap-2 rounded-lg border bg-card py-1.5 pr-3 pl-1.5 text-left text-sm transition-colors hover:border-brand/40"
                          onClick={() => open(t.id)}
                        >
                          <StatusIcon small status={t.status} />
                          <span className="min-w-0 truncate font-medium">
                            {t.title}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {statusLabels[t.status]}
                          </span>
                          <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Card>
      <Dialog open={!!shown} onOpenChange={(v) => !v && setPreview(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogTitle>群組圖片</DialogTitle>
          <DialogDescription>
            {shown ? date(shown.received_at) : ""} · 僅管理者可查看
          </DialogDescription>
          {shown && (
            <img
              className="max-h-[75vh] w-full object-contain"
              src={`/api/messages/${encodeURIComponent(shown.id)}/image`}
              alt="LINE 群組圖片放大檢視"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
