import type { ChangedFileEntry } from "./changed-files";
import { fileChangeCounts, hasRecordedFileChange } from "./changed-files";
import { parseUnifiedHunks, patchFileImages, reverseApplyUnifiedPatch, revertFileDiffs, sameContent } from "./revert-change";

export interface ReviewChangeGroup { id: string; label?: string; entries: ChangedFileEntry[] }
export interface ReviewFile {
  id: string;
  revision: string;
  index: number;
  entry: ChangedFileEntry;
  name: string;
  directory: string;
  group: string;
  additions: number | undefined;
  deletions: number | undefined;
}

const sourceCache = new Map<string, { entry: ChangedFileEntry; revision: string; additions: number | undefined; deletions: number | undefined }>();

/** Exact insertion/deletion totals, without treating the final newline as a new line. */
export function reviewLineCounts(before: string, after: string): { additions: number; deletions: number } | undefined {
  const lines = (value: string): string[] => { if (!value) return []; const result = value.replace(/\r\n/g, "\n").split("\n"); if (result.at(-1) === "") result.pop(); return result; };
  const a = lines(before), b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let oldEnd = a.length, newEnd = b.length;
  while (oldEnd > start && newEnd > start && a[oldEnd - 1] === b[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
  const n = oldEnd - start, m = newEnd - start;
  if (!n || !m) return { additions: m, deletions: n };
  const furthest = new Map<number, number>([[1, 0]]);
  let operations = 0;
  for (let distance = 0; distance <= n + m; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++operations > 1_000_000) return undefined;
      const down = furthest.get(diagonal + 1) ?? 0, right = furthest.get(diagonal - 1) ?? 0;
      let x = diagonal === -distance || (diagonal !== distance && right < down) ? down : right + 1;
      let y = x - diagonal;
      while (x < n && y < m && a[start + x] === b[start + y]) { x += 1; y += 1; }
      furthest.set(diagonal, x);
      if (x >= n && y >= m) return { additions: (distance + m - n) / 2, deletions: (distance + n - m) / 2 };
    }
  }
  return undefined;
}

function fragmentCounts(entry: Extract<ChangedFileEntry, { kind: "fileDiff" }>): { additions: number | undefined; deletions: number | undefined } {
  if (entry.diffs.some(fragment => fragment.truncated || (fragment.operation === "write" && fragment.before === ""))) return { additions: undefined, deletions: undefined };
  const spans: { before: string; after: string }[] = [];
  let previous: typeof entry.diff | undefined;
  for (const fragment of entry.diffs) {
    if (previous?.before === fragment.before && previous.after === fragment.after) continue;
    previous = fragment;
    const last = spans.at(-1);
    const index = last && fragment.before ? last.after.indexOf(fragment.before) : -1;
    if (last && index >= 0 && last.after.indexOf(fragment.before, index + 1) < 0) last.after = last.after.slice(0, index) + fragment.after + last.after.slice(index + fragment.before.length);
    else spans.push({ before: fragment.before, after: fragment.after });
  }
  let additions = 0, deletions = 0;
  for (const span of spans) {
    const counts = reviewLineCounts(span.before, span.after);
    if (!counts) return { additions: undefined, deletions: undefined };
    additions += counts.additions; deletions += counts.deletions;
  }
  return { additions, deletions };
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

export function reviewRelativePath(path: string, root?: string): string {
  const normalized = path.replace(/\\/g, "/");
  const base = root?.replace(/\\/g, "/").replace(/\/$/, "");
  // Windows paths are case-insensitive; a path prefix must end at a directory boundary.
  const windows = /^[a-z]:\//i.test(normalized) || normalized.startsWith("//");
  const candidate = windows ? normalized.toLowerCase() : normalized;
  const prefix = windows ? base?.toLowerCase() : base;
  return prefix && candidate.startsWith(`${prefix}/`) ? normalized.slice(base!.length + 1) : normalized;
}

/** Stable file identities retain selection while streaming events update the projection. */
export function buildReviewFiles(groups: ReviewChangeGroup[], root?: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  for (const group of groups) for (const entry of group.entries) {
    if (!hasRecordedFileChange(entry)) continue;
    const path = entry.path.replace(/\\/g, "/");
    const id = JSON.stringify([group.id, /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLowerCase() : path]);
    const cached = sourceCache.get(id);
    const unchanged = cached && (entry.kind === "patch"
      ? cached.entry.kind === "patch" && cached.entry.diff === entry.diff && cached.entry.edits === entry.edits
        && cached.entry.comparisonUnavailable === entry.comparisonUnavailable && cached.entry.changeType === entry.changeType
        && cached.entry.additions === entry.additions && cached.entry.deletions === entry.deletions
      : cached.entry.kind === "fileDiff" && cached.entry.diffs.length === entry.diffs.length
        && entry.diffs.every((fragment, index) => cached.entry.kind === "fileDiff" && cached.entry.diffs[index] === fragment));
    let source = unchanged ? cached : undefined;
    if (!source) {
      if (entry.kind === "patch") {
        source = { entry, revision: `${entry.edits}:${entry.changeType}:${!!entry.comparisonUnavailable}:${hashText(entry.diff ?? "")}`, ...fileChangeCounts(entry) };
      } else {
        source = { entry, ...fragmentCounts(entry), revision: hashText(JSON.stringify(entry.diffs)) };
      }
      sourceCache.set(id, source);
      if (sourceCache.size > 512) sourceCache.delete(sourceCache.keys().next().value!);
    }
    const relative = reviewRelativePath(entry.path, root);
    const parts = relative.split("/");
    const name = parts.pop() || relative;
    files.push({ id, revision: source.revision, index: files.length, entry: source.entry, name, directory: parts.join("/"), group: group.label ?? "", additions: source.additions, deletions: source.deletions });
  }
  return files;
}

/** Only a creation/deletion patch can supply a complete saved file without
 * reading disk. A modified-file hunk is never promoted to a whole file. */
export function recordedFileVersions(entry: ChangedFileEntry): { before: string; after: string } | undefined {
  if (entry.kind !== "patch" || entry.comparisonUnavailable || !entry.diff) return undefined;
  const hunks = parseUnifiedHunks(entry.diff);
  if (hunks.length !== 1) return undefined;
  const hunk = hunks[0];
  const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/m.exec(entry.diff);
  if (!header || Number(header[1] ?? 1) !== hunk.preImage.length || Number(header[2] ?? 1) !== hunk.postImage.length) return undefined;
  if (entry.changeType === "added" && hunk.preImage.length === 0 && hunk.hintLine === 1) return { before: "", after: hunk.postImage.join("\n") };
  if (entry.changeType === "deleted" && hunk.postImage.length === 0 && hunk.preHintLine === 1) return { before: hunk.preImage.join("\n"), after: "" };
  return undefined;
}

/** Reconstruct only an exact baseline. Partial patches never pretend to be a whole file. */
export function reviewBefore(entry: ChangedFileEntry, liveContent: string): string | undefined {
  if (entry.kind === "fileDiff") {
    // A write-tool input contains the new body only. Its empty `before` is
    // missing information, not proof that the file was newly created.
    if (entry.diffs.some(fragment => fragment.truncated || (fragment.operation === "write" && fragment.before === ""))) return undefined;
    // Some native timelines repeat the same edit in start/result events. A
    // duplicate receipt is not a second filesystem mutation.
    const diffs = entry.diffs.filter((fragment, index, all) => index === 0
      || fragment.before !== all[index - 1].before || fragment.after !== all[index - 1].after);
    const reverted = revertFileDiffs(liveContent, diffs);
    return reverted.ok ? reverted.content : undefined;
  }
  if (entry.comparisonUnavailable || !entry.diff) return undefined;
  if (entry.changeType === "added") return sameContent(liveContent, patchFileImages(entry.diff).after) ? "" : undefined;
  const reverted = reverseApplyUnifiedPatch(liveContent, entry.diff);
  return reverted.ok ? reverted.content : undefined;
}

export function reviewMatches(file: ReviewFile, query: string): boolean {
  return `${file.directory}/${file.name} ${file.group}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}
