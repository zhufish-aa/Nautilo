/**
 * Returns the newest non-empty line/fragment of a reasoning stream.
 * A streaming event grows in place, so recalculating this value on render keeps
 * the collapsed preview synchronized with the latest received reasoning text.
 */
export function latestReasoningSummary(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}
