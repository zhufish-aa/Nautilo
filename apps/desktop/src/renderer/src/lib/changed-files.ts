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

export function collectChangedFiles(events: TimelineEvent[]): ChangedFileEntry[] {
  const byPath = new Map<string, ChangedFileEntry>();
  const flattened: TimelineEvent[] = [];
  const flatten = (items: TimelineEvent[]): void => {
    for (const event of items) {
      if (event.data.kind === "tool_group") flatten(event.data.items);
      else flattened.push(event);
    }
  };
  flatten(events);
  const scope = (event: TimelineEvent): string => JSON.stringify([event.sessionId, event.runId ?? ""]);
  const nativeByRun = new Map<string, TimelineEvent>();
  for (const event of flattened) {
    if (event.data.kind === "file_change" && event.data.source === "provider" && event.data.replace) nativeByRun.set(scope(event), event);
  }

  const visit = (items: TimelineEvent[]): void => {
    for (const event of items) {
      const data = event.data;
      // A provider snapshot replaces this run, including an empty snapshot.
      // Filter old and late item patches *before* path aggregation so another
      // run/session's contribution survives a native withdrawal.
      const native = nativeByRun.get(scope(event));
      if (native && native !== event && (data.kind === "file_change" || data.kind === "tool_activity")) continue;
      if (data.kind === "tool_group") {
        visit(data.items);
        continue;
      }
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
        const fileDiff = data.fileDiff ?? toolInputFileDiff(data.toolName, data.input);
        const path = fileDiff?.path;
        if (!fileDiff || !path) continue;
        const existing = byPath.get(path);
        // A textual patch is the richer representation; only bump its counter.
        if (existing?.kind === "patch" && (existing.diff || existing.comparisonUnavailable)) {
          byPath.set(path, { ...existing, edits: existing.edits + 1 });
          continue;
        }
        byPath.set(path, {
          kind: "fileDiff",
          path,
          diff: fileDiff,
          diffs: [...(existing?.kind === "fileDiff" ? existing.diffs : []), fileDiff],
          edits: (existing?.edits ?? 0) + 1
        });
      }
    }
  };

  visit(flattened);
  return [...byPath.values()];
}
