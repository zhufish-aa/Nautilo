import type { TimelineEvent } from "./types";

export interface ConversationLocation {
  id: string;
  rowKey: string;
  rowIndex: number;
  title: string;
  preview: string;
  timestamp: string;
}

const excerpt = (text: string, limit: number): string => text.replace(/\s+/g, " ").trim().slice(0, limit);

/** Use the actual ordered user-message rows, including accepted steering.
 * Tool output and replies never create a second marker for the same question. */
export function conversationLocations(events: readonly TimelineEvent[], rows: readonly { key: string }[], previous?: ConversationLocation[]): ConversationLocation[] {
  const indexes = new Map(rows.map((row, index) => [row.key, index]));
  const locations: ConversationLocation[] = [];
  let current: ConversationLocation | undefined;
  for (const event of events) {
    if (event.data.kind !== "message") continue;
    if (event.data.sender === "user") {
      current = undefined;
      const rowIndex = indexes.get(event.id);
      if (rowIndex === undefined) continue;
      current = { id: event.data.messageId ?? event.id, rowKey: event.id, rowIndex,
        title: excerpt(event.data.text || event.data.attachments?.map(item => item.name).join(", ") || "…", 240),
        preview: "", timestamp: event.timestamp };
      locations.push(current);
    } else if (current && event.data.sender === "agent") {
      // A bounded excerpt stays stable once a long streamed reply exceeds it.
      current.preview = excerpt(event.data.text, 160);
    }
  }
  if (previous?.length === locations.length && locations.every((item, index) => {
    const old = previous[index];
    return item.id === old.id && item.rowKey === old.rowKey && item.rowIndex === old.rowIndex && item.title === old.title && item.preview === old.preview && item.timestamp === old.timestamp;
  })) return previous;
  return locations;
}

export function locationAtRow(locations: readonly ConversationLocation[], rowIndex: number): number {
  let low = 0;
  let high = locations.length - 1;
  let answer = 0;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (locations[middle].rowIndex <= rowIndex) { answer = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return answer;
}
