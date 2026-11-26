import type { Message } from "@agenthub/domain";
import type { TimelineEvent } from "./types";

const receiptLine = /^ {0,3}(?:(?:[-+*]|\d+[.)])[ \t]+)?(?:\*\*)?(任务|子会话|task|(?:child[ \t]+)?session)[ \t]*id[ \t]*[:：]?(?:\*\*)?[ \t]*[:：]?[ \t]*`?([\w-]+)`?[ \t]*[。.]?[ \t]*\r?$/i;

/** Hide an appended receipt footer for IDs belonging to this conversation. */
export function withoutDelegationReceipt(
  text: string,
  matches: (kind: "task" | "session", id: string) => boolean
): string {
  const lines = text.trimEnd().split("\n");
  let end = lines.length;
  for (; end > 0; end--) {
    const line = lines[end - 1];
    if (!line.trim()) continue;
    const receipt = receiptLine.exec(line);
    if (!receipt || !matches(/^(任务|task)$/i.test(receipt[1]) ? "task" : "session", receipt[2])) break;
  }
  // Leave direct ID-only answers and literal text in an open code fence intact.
  if (end === lines.length || end === 0) return text;
  let fence = "";
  for (const line of lines.slice(0, end)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (!fence) fence = marker[1];
    else if (marker[1].startsWith(fence) && !marker[2].trim()) fence = "";
  }
  return fence ? text : lines.slice(0, end).join("\n");
}

/** Internal orchestration messages stay persisted, but do not read as chat. */
export function isVisibleTimelineMessage(message: Message): boolean {
  if (message.kind === "planner_decision" || message.kind === "delegation") return false;
  if (message.kind === "result") return false;
  if (message.kind === "recovery" && message.sender === "agent") return false;
  return true;
}

/** Run completion for hidden machine messages would otherwise produce a duplicate status row. */
export function hiddenCompletionRunIds(messages: Message[]): Set<string> {
  return new Set(messages
    .filter((message) => !isVisibleTimelineMessage(message) && message.runId)
    .map((message) => String(message.runId)));
}

/** Old builds asked the main Agent to acknowledge child results; hide that whole obsolete turn. */
export function hiddenInternalRunIds(messages: Message[]): Set<string> {
  return new Set(messages
    .filter((message) => message.sender === "agent" && (message.kind === "result" || message.kind === "recovery") && message.runId)
    .map((message) => String(message.runId)));
}

/**
 * Projects verbose orchestration events into one mutable task card per delegation.
 * The source events are untouched and remain available to diagnostics and replay.
 */
export function compactOrchestrationTimeline(timeline: TimelineEvent[], mainSessionId?: string): TimelineEvent[] {
  const childSessionByTask = new Map<string, string>();
  for (const event of timeline) {
    if (event.data.kind !== "handoff" || !event.data.taskId || !event.data.sessionId) continue;
    if (event.data.sessionId !== mainSessionId) childSessionByTask.set(event.data.taskId, event.data.sessionId);
  }

  const compacted: TimelineEvent[] = [];
  const taskRows = new Map<string, number>();
  for (const event of timeline) {
    if (event.data.kind === "planner_decision" || event.data.kind === "handoff") continue;
    if (event.data.kind === "run_status" && event.data.run.status === "running") continue;
    if (event.data.kind !== "task_update") {
      compacted.push(event);
      continue;
    }

    const data = {
      ...event.data,
      sessionId: childSessionByTask.get(event.data.taskId) ?? event.data.sessionId
    };
    const existing = taskRows.get(event.data.taskId);
    if (existing === undefined) {
      taskRows.set(event.data.taskId, compacted.length);
      compacted.push({ ...event, data });
      continue;
    }
    // Status updates must not change the task's original position or timestamp.
    compacted[existing] = { ...compacted[existing], data };
  }
  return compacted;
}
