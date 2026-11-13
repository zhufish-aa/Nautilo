import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { respondJson, type Json } from "./http.js";

export async function writeCompletion(
  res: ServerResponse,
  body: Json,
  nextFrame: () => Promise<IteratorResult<Json>>,
  cancel: () => Promise<void>,
  finishTurn: () => void,
): Promise<void> {
  const id = `chatcmpl-${randomUUID()}`,
    model = body.model,
    stream = body.stream === true;
  let content = "",
    reasoning = "",
    usage: unknown,
    tools: unknown[] = [],
    finish = "stop";
  if (stream)
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
  const emit = (delta: unknown, reason: string | null = null) => {
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
    );
  };
  for (;;) {
    const next = await nextFrame();
    if (next.done)
      throw Error("Native account stream closed without a terminal event");
    const frame = next.value;
    if (frame.error) {
      await cancel();
      throw Error(frame.error);
    }
    if (frame.done) {
      finishTurn();
      break;
    }
    if (frame.usage) {
      usage = frame.usage;
      continue;
    }
    if (frame.content) content += frame.content;
    if (frame.reasoning_content) reasoning += frame.reasoning_content;
    if (stream) emit(frame);
    if (frame.tool_calls) {
      tools = frame.tool_calls;
      finish = "tool_calls";
      break;
    }
  }
  if (stream) {
    emit({}, finish);
    if (usage)
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [], usage })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  } else
    respondJson(res, 200, {
      id,
      object: "chat.completion",
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            reasoning_content: reasoning,
            tool_calls: tools,
          },
          finish_reason: finish,
        },
      ],
      usage,
    });
}
