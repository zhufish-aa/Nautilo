export interface TimelinePosition {
  top: number;
  follow: boolean;
  rowKey?: string;
  offset?: number;
}

/** View state only. Never persist conversation text or keep unbounded session caches. */
export class TimelinePositions {
  private readonly values = new Map<string, TimelinePosition>();
  constructor(private readonly capacity = 100) {}

  get(key: string): TimelinePosition | undefined {
    const position = this.values.get(key);
    if (position) {
      this.values.delete(key);
      this.values.set(key, position);
    }
    return position;
  }

  set(key: string, position: TimelinePosition): void {
    if (!Number.isFinite(position.top)) return;
    this.values.delete(key);
    this.values.set(key, { ...position, top: Math.max(0, position.top), follow: position.follow });
    while (this.values.size > this.capacity) this.values.delete(this.values.keys().next().value!);
  }
}

export const timelinePositions = new TimelinePositions();

/** A folded/removed row falls back to its nearest surviving predecessor. */
export function resolveReadingAnchor(key: string | undefined, next: readonly string[], previous: readonly string[] = []): number {
  if (!key) return -1;
  const indexes = new Map(next.map((value, index) => [value, index]));
  const exact = indexes.get(key);
  if (exact !== undefined) return exact;
  for (let index = previous.indexOf(key) - 1; index >= 0; index--) {
    const found = indexes.get(previous[index]);
    if (found !== undefined) return found;
  }
  return -1;
}
