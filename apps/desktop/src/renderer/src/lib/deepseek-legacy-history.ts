import type { Message } from "@agenthub/domain";
import type { RuntimeEvent } from "@agenthub/event-protocol";

/** Repair the presentation of replies saved by the old DSH attempt-ID adapter.
 * A closed native runtime cannot produce a reply to a later foreground turn.
 * Only recover that proven collision; real late child/background work keeps
 * its originating run. The append-only journal is left untouched.
 */
export function recoverLegacyDeepSeekReplies(messages: Message[], events: RuntimeEvent[]): { messages: Message[]; events: RuntimeEvent[] } {
  const closed = new Set<string>();
  const active = new Map<string, { runId: string; deepseek: boolean }>();
  const recoveredMessages = new Map<string, string>();
  let changed = false;
  const recovered = events.map(event => {
    const sessionId = String(event.sessionId);
    if (event.type === "run.started" && event.runId) active.set(sessionId, { runId: event.runId, deepseek: false });
    const turn = active.get(sessionId);
    if (event.type === "provider.runtime_ready" && turn && turn.runId === event.runId) turn.deepseek = event.payload.providerId === "deepseek";
    if (event.type === "provider.runtime_closed" && event.runId) closed.add(event.runId);
    if (["run.completed", "run.failed", "run.cancelled"].includes(event.type) && turn?.runId === event.runId) active.delete(sessionId);
    if (event.type !== "agent.message" && event.type !== "agent.message_delta" && event.type !== "agent.thinking_delta" && event.type !== "agent.thinking_summary") return event;
    if (!event.background || !event.runId || !closed.has(event.runId) || !turn?.deepseek || turn.runId === event.runId || event.payload.subagentDispatchId) return event;
    const nativeId = event.type === "agent.message" ? event.payload.providerMessageId : event.payload.messageId;
    // Legacy IDs repeat the session name, then append lifecycle-local counters.
    // The fixed adapter inserts a UUID namespace and never matches this shape.
    if (typeof nativeId !== "string" || !/^(.+):\1:\d+:\d+$/.test(nativeId)) return event;
    changed = true;
    if (event.type === "agent.message" && typeof event.payload.messageId === "string") recoveredMessages.set(event.payload.messageId, turn.runId);
    return { ...event, runId: turn.runId, background: undefined };
  });
  if (!changed) return { messages, events };
  return {
    events: recovered,
    messages: messages.map(message => {
      const runId = recoveredMessages.get(message.id);
      return runId && message.sender === "agent" ? { ...message, runId, background: undefined } : message;
    })
  };
}
