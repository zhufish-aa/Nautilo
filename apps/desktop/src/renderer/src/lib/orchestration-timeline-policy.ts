import type { Message } from "@agenthub/domain";
import type { TimelineEvent } from "./types";

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
    compacted[existing] = { ...event, id: compacted[existing].id, data };
  }
  return compacted;
}
