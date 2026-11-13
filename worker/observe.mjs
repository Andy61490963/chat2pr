// 只輸出可觀察工作事件，不輸出推理、提示詞、工具參數或登入檔。
export async function observeTurn(thread, prompt, options, emit) {
  let final = "",
    usage = null,
    threadId = null,
    completed = false;
  const { events } = await thread.runStreamed(prompt, options);
  for await (const e of events) {
    if (e.type === "thread.started") {
      threadId = e.thread_id;
      emit({ kind: "thread", threadId: e.thread_id });
    }
    if (e.type === "turn.completed") {
      completed = true;
      usage = e.usage;
      emit({ kind: "usage", detail: JSON.stringify(e.usage) });
    }
    if (e.type === "turn.failed" || e.type === "error") {
      const message = e.error?.message ?? e.message ?? "Codex 執行失敗";
      emit({ kind: "error", detail: message });
      if (e.type === "turn.failed") throw new Error(message);
    }
    const item = e.item;
    if (!item) continue;
    if (
      item.type === "command_execution" &&
      ["item.started", "item.completed"].includes(e.type)
    )
      emit({
        kind: e.type === "item.started" ? "command_start" : "command_end",
        detail:
          `${item.command}\n${(item.aggregated_output ?? "").slice(-5000)}`.slice(
            0,
            6000,
          ),
        exitCode: item.exit_code,
      });
    if (e.type !== "item.completed") continue;
    if (item.type === "agent_message") {
      final = item.text;
      emit({ kind: "message", detail: item.text.slice(0, 6000) });
    }
    if (item.type === "file_change")
      emit({
        kind: "files",
        detail: JSON.stringify(item.changes).slice(0, 6000),
      });
    if (item.type === "error")
      emit({ kind: "error", detail: item.message.slice(0, 6000) });
  }
  if (!completed) throw new Error("Codex 事件串流未完成，請檢查網路或執行中斷");
  return { final, usage, threadId };
}
