/** Retain all logs in the store, mount only a bounded tail until earlier rows are requested. */
export function terminalWindowStart(total: number, limit: number): number {
  return Math.max(0, Math.floor(total) - Math.max(1, Math.floor(limit)));
}
