/**
 * Line-level diff for the tool edit preview (before/after fragments from
 * edit/write tool calls, not unified patches). LCS aligns unchanged lines so
 * the view interleaves removals and additions instead of dumping one red
 * block followed by one green block; paired lines then get intra-line
 * emphasis via their common prefix/suffix.
 */

export interface DiffSegment {
  text: string;
  changed: boolean;
}

export type DiffRow =
  | { type: "same"; text: string }
  | { type: "removed"; text: string; segments: DiffSegment[] }
  | { type: "added"; text: string; segments: DiffSegment[] };

/** Above this DP matrix size the edit distance is not worth computing. */
const MAX_MATRIX_CELLS = 200_000;

export function diffLines(before: string, after: string): DiffRow[] {
  const oldLines = before ? before.split(/\r?\n/) : [];
  const newLines = after ? after.split(/\r?\n/) : [];
  if (!oldLines.length) return newLines.map(addedRow);
  if (!newLines.length) return oldLines.map(removedRow);

  const rows = oldLines.length * newLines.length > MAX_MATRIX_CELLS
    ? [...oldLines.map(removedRow), ...newLines.map(addedRow)]
    : align(oldLines, newLines);
  pairIntraLine(rows);
  return rows;
}

function removedRow(text: string): DiffRow {
  return { type: "removed", text, segments: [{ text, changed: false }] };
}

function addedRow(text: string): DiffRow {
  return { type: "added", text, segments: [{ text, changed: false }] };
}

/** LCS-based alignment of two line lists into same/removed/added rows. */
function align(oldLines: string[], newLines: string[]): DiffRow[] {
  const m = oldLines.length;
  const n = newLines.length;
  const width = n + 1;
  const dp = new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * width + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ type: "same", text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      rows.push(removedRow(oldLines[i]));
      i += 1;
    } else {
      rows.push(addedRow(newLines[j]));
      j += 1;
    }
  }
  while (i < m) rows.push(removedRow(oldLines[i++]));
  while (j < n) rows.push(addedRow(newLines[j++]));
  return rows;
}

/**
 * Pairs the k-th removed line with the k-th added line inside every
 * removed-block/added-block boundary and marks the differing middle of each
 * pair as changed segments.
 */
function pairIntraLine(rows: DiffRow[]): void {
  let index = 0;
  while (index < rows.length) {
    if (rows[index].type !== "removed") {
      index += 1;
      continue;
    }
    let removedEnd = index;
    while (removedEnd < rows.length && rows[removedEnd].type === "removed") removedEnd += 1;
    let addedEnd = removedEnd;
    while (addedEnd < rows.length && rows[addedEnd].type === "added") addedEnd += 1;
    const pairs = Math.min(removedEnd - index, addedEnd - removedEnd);
    for (let k = 0; k < pairs; k += 1) {
      const removed = rows[index + k];
      const added = rows[removedEnd + k];
      if (removed.type !== "removed" || added.type !== "added") continue;
      const inline = inlineSegments(removed.text, added.text);
      removed.segments = inline.removed;
      added.segments = inline.added;
    }
    index = addedEnd;
  }
}

/** Splits both lines into unchanged prefix / changed middle / unchanged suffix. */
function inlineSegments(oldLine: string, newLine: string): { removed: DiffSegment[]; added: DiffSegment[] } {
  let start = 0;
  const shared = Math.min(oldLine.length, newLine.length);
  while (start < shared && oldLine[start] === newLine[start]) start += 1;
  let oldEnd = oldLine.length;
  let newEnd = newLine.length;
  while (oldEnd > start && newEnd > start && oldLine[oldEnd - 1] === newLine[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return {
    removed: segments(oldLine, start, oldEnd),
    added: segments(newLine, start, newEnd)
  };
}

function segments(line: string, start: number, end: number): DiffSegment[] {
  const out: DiffSegment[] = [];
  if (start > 0) out.push({ text: line.slice(0, start), changed: false });
  if (end > start) out.push({ text: line.slice(start, end), changed: true });
  if (end < line.length) out.push({ text: line.slice(end), changed: false });
  return out.length ? out : [{ text: line, changed: false }];
}
