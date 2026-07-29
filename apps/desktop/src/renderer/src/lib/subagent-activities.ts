import type { RuntimeEvent } from "@agenthub/event-protocol";
import type { TimelinePayload } from "./types";

/**
 * Collects provider-native sub-agent activity into per-dispatch buckets.
 *
 * Adapters tag events produced inside a CLI's own sub-agent with the dispatch
 * tool call's id (`subagentDispatchId`). Those events must not appear as
 * top-level timeline rows; they are grouped here and attached to the dispatch
 * card (see orchestration-runtime's appendRuntimeEvents).
 */
export function subagentDispatchIdOf(event: RuntimeEvent): string | undefined {
  const payload = event.payload as { subagentDispatchId?: unknown };
  return typeof payload.subagentDispatchId === "string" && payload.subagentDispatchId ? payload.subagentDispatchId : undefined;
}

export function collectSubagentActivities(events: RuntimeEvent[]): Map<string, TimelinePayload[]> {
  const buckets = new Map<string, TimelinePayload[]>();
  /** Per-bucket merge indices: message/thinking by messageId, tool/command by callId. */
  const mergeKeys = new Map<string, Map<string, number>>();

  const put = (dispatchId: string, mergeKey: string | undefined, data: TimelinePayload, merge?: (current: TimelinePayload, next: TimelinePayload) => TimelinePayload): void => {
    let bucket = buckets.get(dispatchId);
    if (!bucket) {
      bucket = [];
      buckets.set(dispatchId, bucket);
      mergeKeys.set(dispatchId, new Map());
    }
    const keys = mergeKeys.get(dispatchId)!;
    const existing = mergeKey !== undefined ? keys.get(mergeKey) : undefined;
    if (existing !== undefined && merge) {
      bucket[existing] = merge(bucket[existing], data);
      return;
    }
    if (mergeKey !== undefined) keys.set(mergeKey, bucket.length);
    bucket.push(data);
  };

  for (const event of events) {
    const dispatchId = subagentDispatchIdOf(event);
    if (!dispatchId) continue;
    switch (event.type) {
      case "agent.message_delta":
        put(dispatchId, `msg:${event.payload.messageId}`, { kind: "message", sender: "agent", text: event.payload.text, streaming: true, messageId: event.payload.messageId }, (current, next) =>
          current.kind === "message" && next.kind === "message" ? { ...current, text: current.text + next.text } : next);
        break;
      case "agent.message":
        put(dispatchId, `msg:${event.payload.messageId}`, { kind: "message", sender: "agent", text: event.payload.text, streaming: false, messageId: event.payload.messageId }, (current, next) =>
          current.kind === "message" && next.kind === "message" ? { ...next, text: next.text || current.text } : next);
        break;
      case "agent.thinking_delta":
        put(dispatchId, `think:${event.payload.messageId}`, { kind: "reasoning", text: event.payload.text, streaming: true, messageId: event.payload.messageId }, (current, next) =>
          current.kind === "reasoning" && next.kind === "reasoning" ? { ...current, text: current.text + next.text } : next);
        break;
      case "agent.thinking_summary":
        put(dispatchId, `think:${event.payload.messageId ?? "default"}`, { kind: "reasoning", text: event.payload.text, streaming: false, messageId: event.payload.messageId }, (current, next) =>
          current.kind === "reasoning" && next.kind === "reasoning" ? { ...next, text: next.text || current.text } : next);
        break;
      case "tool.started":
        put(dispatchId, event.payload.callId ? `tool:${event.payload.callId}` : undefined, {
          kind: "tool_activity",
          toolName: event.payload.toolName,
          status: "running",
          input: event.payload.inputSummary,
          fileDiff: event.payload.fileDiff
        }, (current, next) => current.kind === "tool_activity" && next.kind === "tool_activity"
          ? { ...next, status: current.status, input: next.input ?? current.input, fileDiff: next.fileDiff ?? current.fileDiff }
          : next);
        break;
      case "tool.finished":
        put(dispatchId, event.payload.callId ? `tool:${event.payload.callId}` : undefined, {
          kind: "tool_activity",
          toolName: event.payload.toolName,
          status: event.payload.success ? "done" : "failed",
          input: event.payload.inputSummary,
          output: event.payload.outputSummary,
          fileDiff: event.payload.fileDiff
        }, (current, next) => current.kind === "tool_activity" && next.kind === "tool_activity"
          ? {
              ...current,
              toolName: current.toolName === "tool" ? next.toolName : current.toolName,
              status: next.status,
              input: next.input ?? current.input,
              output: next.output ?? current.output,
              fileDiff: next.fileDiff ?? current.fileDiff
            }
          : next);
        break;
      case "command.started":
        put(dispatchId, event.payload.callId ? `cmd:${event.payload.callId}` : `cmd:${event.payload.command}`, {
          kind: "command",
          command: event.payload.command,
          status: "running",
          output: ""
        }, (current, next) => current.kind === "command" && next.kind === "command"
          ? { ...next, status: current.status, exitCode: current.exitCode, output: current.output }
          : next);
        break;
      case "command.finished":
        put(dispatchId, event.payload.callId ? `cmd:${event.payload.callId}` : `cmd:${event.payload.command ?? "command"}`, {
          kind: "command",
          command: event.payload.command ?? "command",
          status: event.payload.exitCode === 0 ? "done" : "failed",
          exitCode: event.payload.exitCode,
          output: event.payload.outputSummary ?? ""
        }, (current, next) => current.kind === "command" && next.kind === "command"
          ? { ...current, status: next.status, exitCode: next.exitCode ?? current.exitCode, output: next.output || current.output }
          : next);
        break;
      default:
        break;
    }
  }
  return buckets;
}
