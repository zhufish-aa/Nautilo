import { CoreError } from "../errors.js";

type Frame = Record<string, any>;
function invalid(reason: string): never {
  throw new CoreError("IPC_INVALID_REQUEST", { field: "model", reason });
}
export async function readAssistantStream(
  response: Response,
  protocol: string,
  stepId: string,
): Promise<Frame> {
  const reader = response.body?.getReader();
  if (!reader) return invalid("助手模型流为空。");
  const decoder = new TextDecoder();
  let buffer = "",
    data: string[] = [],
    text = "",
    name = "",
    args = "",
    index: number | undefined;
  let usage: Frame = {},
    final: Frame | undefined,
    complete = false;
  function accept(frame: string) {
    if (frame.trim() === "[DONE]") {
      complete = true;
      return;
    }
    const e: Frame = JSON.parse(frame);
    let delta = "";
    if (e.error || ["error", "response.failed", "response.incomplete"].includes(e.type))
      invalid("助手模型未能完成本次流式回复。");
    if (protocol === "responses") {
      if (e.type === "response.output_text.delta") delta = e.delta ?? "";
      else if (
        e.type === "response.output_item.added" &&
        e.item?.type === "function_call" &&
        index === undefined
      ) {
        index = e.output_index;
        name = e.item.name;
      } else if (e.type === "response.function_call_arguments.delta" && e.output_index === index)
        args += e.delta ?? "";
      else if (e.type === "response.function_call_arguments.done" && e.output_index === index)
        args = e.arguments ?? args;
      else if (e.type === "response.completed") {
        complete = true;
        final = e.response;
        usage = e.response?.usage ?? {};
      }
    } else if (protocol === "anthropic") {
      if (e.type === "message_start") usage = e.message?.usage ?? {};
      else if (
        e.type === "content_block_start" &&
        e.content_block?.type === "tool_use" &&
        index === undefined
      ) {
        index = e.index;
        name = e.content_block.name;
        if (Object.keys(e.content_block.input ?? {}).length) args = JSON.stringify(e.content_block.input);
      } else if (e.type === "content_block_delta") {
        if (e.delta?.type === "text_delta") delta = e.delta.text;
        else if (e.index === index && e.delta?.type === "input_json_delta") args += e.delta.partial_json;
      } else if (e.type === "message_delta") {
        if (e.delta?.stop_reason === "max_tokens") invalid("助手回复达到了模型输出上限。");
        Object.assign(usage, e.usage);
      } else if (e.type === "message_stop") complete = true;
    } else {
      const choice = e.choices?.[0];
      if (e.usage) usage = e.usage;
      if (["length", "content_filter"].includes(choice?.finish_reason)) invalid("助手回复被供应商提前结束。");
      if (choice?.finish_reason) complete = true;
      delta = choice?.delta?.content ?? "";
      for (const call of choice?.delta?.tool_calls ?? [])
        if ((call.index ?? 0) === 0) {
          name += call.function?.name ?? "";
          args += call.function?.arguments ?? "";
        }
    }
    if (delta) {
      text += delta;
      if (stepId && process.env.NAUTILO_ASSISTANT_STREAM === "1")
        process.stdout.write(JSON.stringify({ event: "assistant.text", stepId, text: delta }) + "\n");
    }
    if (text.length + args.length > 1024 * 1024) invalid("助手回复过长。");
  }
  function lines(part: string) {
    buffer += part;
    if (buffer.length > 20 * 1024 * 1024) invalid("模型流事件过大。");
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (!line) {
        if (data.length) accept(data.join("\n"));
        data = [];
      } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      lines(decoder.decode(part.value, { stream: true }));
    }
    lines(decoder.decode() + "\n\n");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!complete) invalid("助手模型连接已中断，未收到完整回复。");
  if (protocol === "responses")
    return final?.output?.length
      ? final
      : {
          output: [
            name
              ? { type: "function_call", name, arguments: args || "{}" }
              : { type: "message", content: [{ type: "output_text", text }] },
          ],
          usage,
        };
  if (protocol === "anthropic")
    return {
      content: [name ? { type: "tool_use", name, input: JSON.parse(args || "{}") } : { type: "text", text }],
      usage,
    };
  return {
    choices: [
      { message: { content: text, tool_calls: name ? [{ function: { name, arguments: args || "{}" } }] : [] } },
    ],
    usage,
  };
}
