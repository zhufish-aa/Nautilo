import type { ToolFileDiff } from "@agenthub/event-protocol";

/**
 * Reverse-applying recorded changes to a file's current content ("撤回").
 * Pure functions: the caller handles reading/writing the file. Everything is
 * exact-match based — when the file has diverged since the agent's edit the
 * functions report failure instead of guessing, so a revert can never corrupt
 * unrelated content.
 */

export type RevertResult = { ok: true; content: string } | { ok: false };

function normalizeEol(content: string): { text: string; hadCrlf: boolean } {
  const hadCrlf = content.includes("\r\n");
  return { text: hadCrlf ? content.replace(/\r\n/g, "\n") : content, hadCrlf };
}

function restoreEol(text: string, hadCrlf: boolean): string {
  return hadCrlf ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Reverts before/after edit fragments (kimi/opencode edit & write tools),
 * newest first so multi-edit files unwind in the opposite order they were
 * made. A truncated diff or a fragment that no longer matches fails the whole
 * revert. A pure-deletion fragment (empty `after`) has no anchor to re-insert
 * at and also fails.
 */
export function revertFileDiffs(content: string, diffs: ToolFileDiff[]): RevertResult {
  const { text, hadCrlf } = normalizeEol(content);
  let current = text;
  for (const diff of [...diffs].reverse()) {
    if (diff.truncated) return { ok: false };
    const before = (diff.before ?? "").replace(/\r\n/g, "\n");
    const after = (diff.after ?? "").replace(/\r\n/g, "\n");
    if (!after) return { ok: false };
    const index = current.indexOf(after);
    if (index < 0) return { ok: false };
    current = current.slice(0, index) + before + current.slice(index + after.length);
  }
  return { ok: true, content: restoreEol(current, hadCrlf) };
}

export interface UnifiedHunk {
  /** 1-based start line in the post-edit file, from the @@ header. */
  hintLine: number;
  /** 1-based start line in the pre-edit file, from the @@ header. */
  preHintLine: number;
  preImage: string[];
  postImage: string[];
  /** Indices of '-' lines within preImage (the actual removals, sans context). */
  removedOffsets: number[];
  /** Indices of '+' lines within postImage (the actual additions, sans context). */
  addedOffsets: number[];
}

/** Parses the hunks of a unified diff; file headers and "\ No newline" markers are skipped. */
export function parseUnifiedHunks(patch: string): UnifiedHunk[] {
  const hunks: UnifiedHunk[] = [];
  let current: UnifiedHunk | undefined;
  for (const rawLine of patch.replace(/\r\n/g, "\n").split("\n")) {
    const header = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      current = { hintLine: Number(header[2]), preHintLine: Number(header[1]), preImage: [], postImage: [], removedOffsets: [], addedOffsets: [] };
      hunks.push(current);
      continue;
    }
    if (!current || rawLine.startsWith("\\")) continue;
    const tag = rawLine[0];
    const line = rawLine.slice(1);
    if (tag === "+") {
      current.addedOffsets.push(current.postImage.length);
      current.postImage.push(line);
    } else if (tag === "-") {
      current.removedOffsets.push(current.preImage.length);
      current.preImage.push(line);
    } else if (tag === " ") {
      current.preImage.push(line);
      current.postImage.push(line);
    }
  }
  return hunks.filter((hunk) => hunk.preImage.length > 0 || hunk.postImage.length > 0);
}

/** Locates an exact line block; when ambiguous, the match nearest the @@ hint wins. */
function findBlock(lines: string[], block: string[], hint: number): number {
  if (block.length === 0) return hint >= 0 && hint <= lines.length ? hint : -1;
  const matches: number[] = [];
  outer: for (let i = 0; i + block.length <= lines.length; i += 1) {
    for (let j = 0; j < block.length; j += 1) {
      if (lines[i + j] !== block[j]) continue outer;
    }
    matches.push(i);
  }
  if (matches.length === 0) return -1;
  matches.sort((a, b) => Math.abs(a - hint) - Math.abs(b - hint));
  return matches[0];
}

/**
 * Reverse-applies a unified diff (codex file_change patches) to the current
 * content, hunks newest-first. Fails when any hunk's post-image no longer
 * matches the file exactly.
 */
export function reverseApplyUnifiedPatch(content: string, patch: string): RevertResult {
  const hunks = parseUnifiedHunks(patch);
  if (hunks.length === 0) return { ok: false };
  const { text, hadCrlf } = normalizeEol(content);
  const lines = text.split("\n");
  for (const hunk of [...hunks].reverse()) {
    const index = findBlock(lines, hunk.postImage, hunk.hintLine - 1);
    if (index < 0) return { ok: false };
    lines.splice(index, hunk.postImage.length, ...hunk.preImage);
  }
  return { ok: true, content: restoreEol(lines.join("\n"), hadCrlf) };
}

/**
 * Best-effort whole-file pre/post images of a patch, for files the agent
 * created or deleted outright (those patches cover the entire file).
 */
export function patchFileImages(patch: string): { before: string; after: string } {
  const hunks = parseUnifiedHunks(patch);
  return {
    before: hunks.flatMap((hunk) => hunk.preImage).join("\n"),
    after: hunks.flatMap((hunk) => hunk.postImage).join("\n")
  };
}

/** Compare helper ignoring trailing-newline differences. */
export function sameContent(a: string, b: string): boolean {
  const strip = (value: string): string => normalizeEol(value).text.replace(/\n+$/, "");
  return strip(a) === strip(b);
}
