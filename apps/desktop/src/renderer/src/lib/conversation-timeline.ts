import type { TimelineEvent } from "./types";

/** Flatten presentation-only tool groups without reordering, cloning, or
 * hiding control events. Stable event identities keep historical rows memoized. */
export function conversationTimeline(events: readonly TimelineEvent[]): TimelineEvent[] {
  const rows: TimelineEvent[] = [];
  const visit = (items: readonly TimelineEvent[]): void => {
    for (const event of items) {
      const data = event.data;
      if (data.kind === "tool_group") visit(data.items);
      else if (data.kind === "usage") continue;
      else if (data.kind === "activity" && data.phase !== "starting") continue;
      else if (data.kind === "run_status" && data.run.status === "completed") continue;
      else rows.push(event);
    }
  };
  visit(events);
  return rows;
}
