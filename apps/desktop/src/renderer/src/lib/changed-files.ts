import type { ToolFileDiff } from "@agenthub/event-protocol";
import type { ChangedFile, TimelineEvent } from "./types";
import { toolInputFileDiff } from "./tool-display";

/** Derives +/- line counts from unified diff text (skips the +++/--- headers). */
export function diffLineCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Historical file.changed rows carry the diff text but no counters (they show
 * as +0 -0); derive from the diff in that case. An explicit non-zero count
 * always wins, and a genuine empty patch keeps its zeros.
 */
export function fileChangeCounts(file: Pick<ChangedFile, "additions" | "deletions" | "diff">): { additions: number; deletions: number } {
  if (file.diff && file.additions === 0 && file.deletions === 0) return diffLineCounts(file.diff);
  return { additions: file.additions, deletions: file.deletions };
}

/**
 * Aggregates per-file changes from a session timeline for the diff panel.
 *
 * Two sources, unified by path (last write wins, edit count kept):
 * - `file_change` timeline events (codex emits `file.changed`) → textual patch.
 * - `fileDiff` attached to tool events, or parsed from edit/write tool input
 *   (kimi adapters never emit `file.changed`) → before/after structure.
 *
 * Tool groups are recursed into so grouped tool calls are covered too.
 */
export type ChangedFileEntry =
  | {
      kind: "patch";
      comparisonUnavailable?: boolean;
      reason?: string;
      path: string;
      changeType: ChangedFile["changeType"];
      additions: number;
      deletions: number;
      diff?: string;
      edits: number;
    }
  // `diff` is the latest fragment (what the drawer renders); `diffs` keeps
  // every fragment oldest→newest so a per-file revert can unwind them all.
  | { kind: "fileDiff"; path: string; diff: ToolFileDiff; diffs: ToolFileDiff[]; edits: number };

type ToolActivity = Extract<TimelineEvent["data"], { kind: "tool_activity" }>;
const toolDiffCache = new WeakMap<ToolActivity, { input: ToolActivity["input"]; name: string; explicit: ToolFileDiff | undefined; result: ToolFileDiff | undefined }>();
function activityDiff(data: ToolActivity): ToolFileDiff | undefined {
  const cached = toolDiffCache.get(data);
  if (cached && cached.input === data.input && cached.name === data.toolName && cached.explicit === data.fileDiff) return cached.result;
  const result = data.fileDiff ?? toolInputFileDiff(data.toolName, data.input);
  toolDiffCache.set(data, { input: data.input, name: data.toolName, explicit: data.fileDiff, result });
  return result;
}

// Badge-only reads retain paths, not parsed before/after file bodies.
const toolPathCache = new WeakMap<ToolActivity, { input: ToolActivity["input"]; name: string; path: string | undefined }>();
function activityPath(data: ToolActivity): string | undefined {
  if (data.fileDiff) return data.fileDiff.path;
  const cached = toolPathCache.get(data);
  if (cached && cached.input === data.input && cached.name === data.toolName) return cached.path;
  const path = toolInputFileDiff(data.toolName, data.input)?.path;
  toolPathCache.set(data, { input: data.input, name: data.toolName, path });
  return path;
}

/** Text/reasoning updates cannot change a file projection. Discard them before
 * scope checks, and apply native replacement semantics equally to counts/diffs. */
function relevantChanges(events: TimelineEvent[]): TimelineEvent[] {
  const flattened: TimelineEvent[] = [];
  const flatten = (items: TimelineEvent[]): void => {
    for (const event of items) {
      if (event.data.kind === "tool_group") flatten(event.data.items);
      else if (event.data.kind === "file_change" || event.data.kind === "tool_activity") flattened.push(event);
    }
  };
  flatten(events);
  const scope = (event: TimelineEvent): string => JSON.stringify([event.sessionId, event.runId ?? ""]);
  const nativeByRun = new Map<string, TimelineEvent>();
  for (const event of flattened) {
    if (event.data.kind === "file_change" && event.data.source === "provider" && event.data.replace) nativeByRun.set(scope(event), event);
  }
  if (nativeByRun.size === 0) return flattened;
  return flattened.filter((event) => {
    const native = nativeByRun.get(scope(event));
    return !native || native === event;
  });
}

/** Badge projection: no patch parsing, line counting, or revert-fragment arrays. */
export function countChangedFiles(events: TimelineEvent[]): number {
  const paths = new Set<string>();
  for (const event of relevantChanges(events)) {
    if (event.data.kind === "file_change") {
      for (const file of event.data.files) paths.add(file.path);
    } else if (event.data.kind === "tool_activity") {
      const path = activityPath(event.data);
      if (path) paths.add(path);
    }
  }
  return paths.size;
}

// Store timelines are immutable snapshots. Weak keys avoid retaining closed
// histories while unchanged child sessions reuse their badge projection.
const countCache = new WeakMap<TimelineEvent[], number>();
export function cachedChangedFileCount(events: TimelineEvent[]): number {
  const cached = countCache.get(events);
  if (cached !== undefined) return cached;
  const count = countChangedFiles(events);
  countCache.set(events, count);
  return count;
}

export function collectChangedFiles(events: TimelineEvent[]): ChangedFileEntry[] {
  const byPath = new Map<string, ChangedFileEntry>();
  const flattened = relevantChanges(events);
  const visit = (items: TimelineEvent[]): void => {
    for (const event of items) {
      const data = event.data;
      if (data.kind === "file_change") {
        for (const file of data.files) {
          const existing = byPath.get(file.path);
          const counts = fileChangeCounts(file);
          byPath.set(file.path, {
            kind: "patch",
            path: file.path,
            changeType: file.changeType,
            comparisonUnavailable: file.comparisonUnavailable,
            reason: file.reason,
            additions: counts.additions,
            deletions: counts.deletions,
            diff: file.comparisonUnavailable ? undefined : file.diff ?? (existing?.kind === "patch" ? existing.diff : undefined),
            edits: (existing?.edits ?? 0) + 1
          });
        }
        continue;
      }
      if (data.kind === "tool_activity") {
        const fileDiff = activityDiff(data);
        const path = fileDiff?.path;
        if (!fileDiff || !path) continue;
        const existing = byPath.get(path);
        // A textual patch is the richer representation; only bump its counter.
        if (existing?.kind === "patch" && (existing.diff || existing.comparisonUnavailable)) {
          byPath.set(path, { ...existing, edits: existing.edits + 1 });
          continue;
        }
        if (existing?.kind === "fileDiff") {
          // This array belongs to this projection, not the input/store. Appending
          // avoids copying 1+2+...+N fragments for repeated edits to one file.
          existing.diffs.push(fileDiff);
          existing.diff = fileDiff;
          existing.edits += 1;
        } else {
          byPath.set(path, { kind: "fileDiff", path, diff: fileDiff, diffs: [fileDiff], edits: (existing?.edits ?? 0) + 1 });
        }
      }
    }
  };

  visit(flattened);
  return [...byPath.values()];
}
