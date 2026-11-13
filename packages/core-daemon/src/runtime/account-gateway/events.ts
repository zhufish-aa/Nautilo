import type { AdapterRun } from "../../adapters/index.js";
import { AsyncQueue } from "../../adapters/async-queue.js";
import type { Json } from "./http.js";

export function streamDelta(
  seen: Map<string, string>,
  key: string,
  text: string,
  phase?: string,
): string {
  const previous = seen.get(key) ?? "";
  if (phase === "delta") {
    seen.set(key, previous + text);
    return text;
  }
  if (!text.startsWith(previous)) return "";
  seen.set(key, text);
  return text.slice(previous.length);
}

export async function forwardNativeEvents(
  run: AdapterRun,
  queue: AsyncQueue<Json>,
  nativeSession: (nativeId: string) => void,
  checkpoint: () => void,
  failureMessage: (message: string) => string,
): Promise<void> {
  const seen = new Map<string, string>();
  try {
    for await (const event of run.events) {
      if (event.kind === "session") nativeSession(event.providerSessionId);
      else if (
        (event.kind === "message" || event.kind === "thinking") &&
        !event.subagentDispatchId
      ) {
        const delta = streamDelta(
          seen,
          `${event.kind}:${event.messageId ?? ""}`,
          event.text,
          event.phase,
        );
        if (delta)
          queue.push(
            event.kind === "message"
              ? { content: delta }
              : { reasoning_content: delta },
          );
      } else if (event.kind === "usage") {
        queue.push({
          usage: {
            prompt_tokens: event.inputTokens,
            completion_tokens: event.outputTokens,
            total_tokens:
              event.inputTokens === undefined ||
              event.outputTokens === undefined
                ? undefined
                : event.inputTokens + event.outputTokens,
            prompt_tokens_details: { cached_tokens: event.cachedInputTokens },
            completion_tokens_details: {
              reasoning_tokens: event.reasoningOutputTokens,
            },
          },
        });
      } else if (event.kind === "error") {
        queue.push({ error: failureMessage(event.error.message) });
        await run.cancel();
        return;
      } else if (event.kind === "timeout") {
        queue.push({ error: "Native account request timed out" });
        await run.cancel();
        return;
      } else if (event.kind === "exit") {
        if (event.exitCode) {
          queue.push({ error: "Native account request failed" });
        } else {
          checkpoint();
          queue.push({ done: true });
        }
        return;
      }
    }
    queue.push({ error: "Native account stream ended without a completion" });
  } catch (error) {
    queue.push({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    queue.close();
  }
}
