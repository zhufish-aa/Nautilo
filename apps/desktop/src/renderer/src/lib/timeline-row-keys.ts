export interface TimelineKeySequence {
  readonly sessionKey: string;
  readonly keys: readonly string[];
  readonly getItemKey: (index: number) => string;
}

/** Keep the virtualizer's measurement dependency stable for text-only updates.
 * Row arrays/functions change on each token; key order, not their identity,
 * determines whether previously measured rows still represent the same items. */
export function reconcileTimelineKeys(
  previous: TimelineKeySequence | undefined,
  rows: readonly { key: string }[],
  sessionKey: string
): TimelineKeySequence {
  if (previous?.sessionKey === sessionKey && previous.keys.length === rows.length) {
    const keys = previous.keys;
    let same = true;
    for (let index = 0; index < rows.length; index++) {
      if (rows[index]!.key !== keys[index]) { same = false; break; }
    }
    if (same) return previous;
  }
  const keys = rows.map((row) => row.key);
  return { sessionKey, keys, getItemKey: (index) => keys[index] ?? String(index) };
}
