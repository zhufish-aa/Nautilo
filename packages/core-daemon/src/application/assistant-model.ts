import type { AssistantDecision, AssistantModelStep } from "@agenthub/schemas";
import { readAssistantStream } from "./assistant-stream.js";
import { CoreError } from "../errors.js";
import { connectionCredentialId } from "../runtime/runtime-connection.js";
import type { ApplicationServices } from "./ipc-handlers.js";

export async function assistantModelStep(
  services: ApplicationServices,
  input: AssistantModelStep,
): Promise<AssistantDecision> {
  const fail = (reason: string): never => {
    throw new CoreError("IPC_INVALID_REQUEST", { field: "model", reason });
  };
  const connection = services.connections.get(input.connectionId);
  const { model, instructions, context, tools } = input;
  if (
    !connection.enabled ||
    connection.kind !== "api" ||
    !connection.models?.some((m) => m.id === model && m.enabled !== false)
  )
    fail("请在设置中选择已启用的助手 API 连接和模型。");
  const key = Object.values(
    services.credentials.environment(connectionCredentialId(connection.id, connection.revision), "codex"),
  )[0];
  if (!key) return fail("助手 API 连接缺少密钥。");
  if (
    !Array.isArray(context) ||
    !context.length ||
    context.length > 128 ||
    context.some((part) => typeof part !== "string") ||
    context.reduce((sum, part) => sum + Buffer.byteLength(part), 0) > 1048576 ||
    Buffer.byteLength(instructions) > 16384 ||
    tools.length > 12
  )
    fail("助手请求超出大小限制。");
  const protocol = connection.protocol;
  const suffix =
    protocol === "responses" ? "/responses" : protocol === "anthropic" ? "/messages" : "/chat/completions";
  const base = connection.baseUrl!.replace(/\/+$/, "");
  const messages = context.map((content) => ({ role: "user", content }));
  const cached = { type: "ephemeral" };
  const anthropicBlocks = context.map((text, i) => ({
    type: "text",
    text,
    ...(i === context.length - 1 ? { cache_control: cached } : {}),
  }));
  const body =
    protocol === "responses"
      ? { model, instructions, input: messages, store: false, max_output_tokens: 4096 }
      : protocol === "anthropic"
        ? {
            model,
            system: [{ type: "text", text: instructions, cache_control: cached }],
            messages: [{ role: "user", content: anthropicBlocks }],
            max_tokens: 4096,
          }
        : { model, messages: [{ role: "system", content: instructions }, ...messages] };
  const functions = tools.map(({ name, description, parameters }) =>
    protocol === "responses"
      ? { type: "function", name, description, parameters }
      : protocol === "anthropic"
        ? { name, description, input_schema: parameters }
        : { type: "function", function: { name, description, parameters } },
  );
  const stepId = input.streamId;
  const options: Record<string, unknown> = { ...body, ...(functions.length ? { tools: functions } : {}) };
  if (stepId) {
    options.stream = true;
    if (protocol === "chat") options.stream_options = { include_usage: true };
  }
  const effort = input.reasoningEffort,
    selected = connection.models?.find((m) => m.id === model);
  if (effort) {
    if (selected?.defaultReasoningEffort !== effort && !selected?.reasoningEfforts?.includes(effort))
      fail("推理强度不在模型配置中。");
    const off = effort === "none" || effort === "off",
      deepseek = model.toLowerCase().includes("deepseek") || new URL(base).hostname === "api.deepseek.com";
    if (protocol === "responses") options.reasoning = { effort: off ? "none" : effort };
    else if (protocol === "anthropic") {
      if (off) options.thinking = { type: "disabled" };
      else {
        options.output_config = { effort };
        if (deepseek) options.thinking = { type: "enabled" };
      }
    } else {
      if (deepseek) options.thinking = { type: off ? "disabled" : "enabled" };
      if (!deepseek || !off) options.reasoning_effort = off ? "none" : effort;
    }
  }
  const response = await fetch(base.endsWith(suffix) ? base : base + suffix, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(90000),
    headers: {
      "content-type": "application/json",
      ...(protocol === "anthropic"
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { Authorization: "Bearer " + key }),
    },
    body: JSON.stringify(options),
  });
  const value =
    response.ok && response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
      ? await readAssistantStream(response, protocol ?? "chat", stepId ?? "")
      : ((await response.json().catch(() => ({}))) as Record<string, any>);
  if (!response.ok)
    fail(
      "HTTP " +
        response.status +
        " · " +
        String(value.error?.message ?? "Model request failed")
          .split(key)
          .join("[REDACTED]")
          .slice(0, 800),
    );
  const blocks: Array<Record<string, any>> = value.output ?? value.content ?? [];
  const message = value.choices?.[0]?.message;
  const tool =
    message?.tool_calls?.[0]?.function ??
    blocks.find((block) => block.type === "tool_use" || block.type === "function_call");
  const usage = value.usage;
  const cacheReadTokens: number | undefined =
    usage?.cache_read_input_tokens ??
    usage?.prompt_cache_hit_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ??
    usage?.input_tokens_details?.cached_tokens;
  const inputTokens: number | undefined =
    protocol === "anthropic" && typeof usage?.input_tokens === "number"
      ? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      : (usage?.input_tokens ?? usage?.prompt_tokens);
  if (tool) {
    const args = tool.input ?? JSON.parse(tool.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) fail("助手模型返回了无效的工具参数。");
    return { call: { name: tool.name, arguments: args }, inputTokens, cacheReadTokens };
  }
  const text: string =
    message?.content ??
    blocks
      .map((block) =>
        block.type === "text"
          ? block.text
          : block.type === "message"
            ? block.content.map((part: { text?: string }) => part.text ?? "").join("")
            : "",
      )
      .join("");
  if (!text?.trim()) fail("助手模型没有返回可用的回答。");
  return { text, inputTokens, cacheReadTokens };
}
