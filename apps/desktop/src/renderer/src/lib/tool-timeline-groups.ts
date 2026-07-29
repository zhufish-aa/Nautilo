import type { TimelineEvent } from "./types";

const GROUPABLE_KINDS = new Set([
  "reasoning",
  "tool_activity",
  "command",
  "file_change",
  "verification"
]);

/**
 * Collapses one continuous model work burst without discarding any underlying
 * event. File changes and verification belong to the calls that produced them;
 * user/agent messages and control events still end the burst.
 */
export function groupToolTimeline(events: TimelineEvent[]): TimelineEvent[] {
  const result: TimelineEvent[] = [];
  let pending: TimelineEvent[] = [];

  const flush = (): void => {
    if (!pending.length) return;
    const stepCount = pending.length;
    const callCount = pending.filter(isToolCall).length;
    if (stepCount < 2) {
      result.push(...pending);
    } else {
      const first = pending[0];
      result.push({
        ...first,
        data: {
          kind: "tool_group",
          items: pending,
          stepCount,
          callCount,
          running: pending.some(isRunningStep)
        }
      });
    }
    pending = [];
  };

  for (const event of events) {
    // A native sub-agent dispatch is a delegation milestone, not an anonymous
    // tool step: keep it out of the collapsed burst so it renders like one.
    const isSubagentDispatch = event.data.kind === "tool_activity" && !!event.data.subagent;
    if (GROUPABLE_KINDS.has(event.data.kind) && !isSubagentDispatch) pending.push(event);
    else {
      flush();
      result.push(event);
    }
  }
  flush();
  return result;
}

function isToolCall(event: TimelineEvent): event is TimelineEvent & {
  data: Extract<TimelineEvent["data"], { kind: "tool_activity" | "command" }>;
} {
  return event.data.kind === "tool_activity" || event.data.kind === "command";
}

function isRunningStep(event: TimelineEvent): boolean {
  if (event.data.kind === "reasoning") return Boolean(event.data.streaming);
  if (event.data.kind === "tool_activity" || event.data.kind === "command") {
    return event.data.status === "running";
  }
  if (event.data.kind === "verification") return event.data.status === "running";
  return false;
}
