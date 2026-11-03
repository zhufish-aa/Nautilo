export const DAG_NODE_WIDTH = 216;
export const DAG_NODE_HEIGHT = 62;
export const DAG_GAP_X = 64;
export const DAG_GAP_Y = 32;
export const DAG_PADDING = 24;

/** Linear-time layout; missing dependencies and cycles cannot inflate the canvas. */
export function layoutDag(
  tasks: readonly { id: string; dependencies: readonly string[] }[]
): Array<{ x: number; y: number; level: number }> {
  const indexOf = new Map(tasks.map((task, index) => [task.id, index]));
  const levels = tasks.map(() => 0);
  const outgoing: number[][] = tasks.map(() => []);
  const pending = tasks.map((task, index) => {
    const dependencies = new Set(
      task.dependencies.filter((id) => id !== task.id && indexOf.has(id))
    );
    for (const id of dependencies) outgoing[indexOf.get(id)!].push(index);
    return dependencies.size;
  });
  const ready = pending.flatMap((count, index) => (count === 0 ? [index] : []));
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const current = ready[cursor]!;
    for (const next of outgoing[current]!) {
      levels[next] = Math.max(levels[next]!, levels[current]! + 1);
      pending[next]!--;
      if (pending[next] === 0) ready.push(next);
    }
  }
  // A malformed cyclic group stays visible in the first column instead of growing forever.
  pending.forEach((count, index) => {
    if (count > 0) levels[index] = 0;
  });
  const counts = new Map<number, number>();
  levels.forEach((level) => counts.set(level, (counts.get(level) ?? 0) + 1));
  const maxRows = Math.max(1, ...counts.values());
  const rows = new Map<number, number>();
  return levels.map((level) => {
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    return {
      level,
      x: DAG_PADDING + level * (DAG_NODE_WIDTH + DAG_GAP_X),
      y: DAG_PADDING + (row + (maxRows - counts.get(level)!) / 2) * (DAG_NODE_HEIGHT + DAG_GAP_Y)
    };
  });
}
