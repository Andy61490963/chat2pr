import type { RequestListener } from "node:http";

export type ModelStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; arguments: Record<string, unknown> }
  | { kind: "error"; status: 400 | 403 | 404 | 429 | 502; message?: string }
  | { kind: "disconnect" };

export function createModelUpstreamHandler(
  steps: readonly ModelStep[],
): RequestListener {
  let position = 0;
  return (request, reply) => {
    request.resume();
    if (request.url !== "/backend-api/codex/responses") {
      reply.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      reply.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const step = steps[position];
    if (!step || step.kind === "error") {
      if (step) position++;
      reply
        .writeHead(step?.status ?? 500, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            error: { message: step ? step.message ?? "模擬上游錯誤" : "驗收腳本已用盡" },
          }),
        );
      return;
    }
    position++;
    const id = "resp_" + position;
    const itemId = (step.kind === "tool" ? "fc_" : "msg_") + position;
    let sequence = 0;
    reply.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    });
    const emit = (type: string, fields: Record<string, unknown>) =>
      reply.write(
        "data: " +
          JSON.stringify({ type, sequence_number: sequence++, ...fields }) +
          "\n\n",
      );
    emit("response.created", {
      response: { id, status: "in_progress", output: [] },
    });
    if (step.kind === "disconnect") {
      reply.end();
      return;
    }
    const item =
      step.kind === "tool"
        ? {
            id: itemId,
            type: "function_call",
            name: step.name,
            call_id: "call_" + position,
            arguments: JSON.stringify(step.arguments),
            status: "completed",
          }
        : {
            id: itemId,
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: step.text, annotations: [] },
            ],
            status: "completed",
          };
    emit("response.output_item.added", {
      output_index: 0,
      item: {
        ...item,
        status: "in_progress",
        ...(step.kind === "tool" ? { arguments: "" } : { content: [] }),
      },
    });
    const location = { item_id: itemId, output_index: 0 };
    if (step.kind === "text" && item.content) {
      const part = item.content[0];
      const slot = { ...location, content_index: 0 };
      emit("response.content_part.added", {
        ...slot,
        part: { ...part, text: "" },
      });
      emit("response.output_text.delta", { ...slot, delta: step.text });
      emit("response.output_text.done", { ...slot, text: step.text });
      emit("response.content_part.done", { ...slot, part });
    } else {
      emit("response.function_call_arguments.delta", {
        ...location,
        delta: item.arguments,
      });
      emit("response.function_call_arguments.done", {
        ...location,
        arguments: item.arguments,
      });
    }
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", {
      response: {
        id,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    reply.end();
  };
}
