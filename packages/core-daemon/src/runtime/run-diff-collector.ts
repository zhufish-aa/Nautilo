import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { GitChangedFile } from "@agenthub/domain";
import { GitCommandRunner } from "./git/index.js";
import type { WorkspaceSnapshot } from "./run-workspace-snapshot.js";

const MAX_FALLBACK_TEXT_BYTES = 1024 * 1024;

interface TouchedFile {
  path: string;
  changeType: GitChangedFile["changeType"];
}

/** Collects displayable diffs for files reported by a provider during one run. */
export class RunDiffCollector {
  constructor(private readonly git = new GitCommandRunner()) {}

  async isGitWorkspace(cwd: string): Promise<boolean> {
    const result = await this.git.run(cwd, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
    return result.exitCode === 0 && result.stdout.trim() === "true";
  }

  async collect(cwd: string, touched: TouchedFile[], baseline?: WorkspaceSnapshot): Promise<GitChangedFile[]> {
    if (!touched.length) return [];
    const rootResult = await this.git.run(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
    if (rootResult.exitCode !== 0) return this.collectSnapshotDiff(cwd, touched, baseline);
    const root = resolve(rootResult.stdout.trim());
    const normalized = uniqueTouchedFiles(root, cwd, touched);
    const files: GitChangedFile[] = [];
    for (const item of normalized) {
      const status = await this.git.run(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", item.path], { allowFailure: true });
      const line = status.stdout.split(/\r?\n/).find(Boolean);
      if (!line) continue;
      const code = line.slice(0, 2);
      const changeType = statusChangeType(code, item.changeType);
      const untracked = code === "??";
      const absolutePath = resolve(root, item.path);
      const [diff, numstat] = untracked
        ? await Promise.all([
            this.git.run(root, ["diff", "--no-index", "--no-ext-diff", "--binary", "--", "/dev/null", absolutePath], { allowFailure: true }),
            this.git.run(root, ["diff", "--no-index", "--numstat", "--", "/dev/null", absolutePath], { allowFailure: true })
          ])
        : await Promise.all([
            this.git.run(root, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", item.path], { allowFailure: true }),
            this.git.run(root, ["diff", "--numstat", "HEAD", "--", item.path], { allowFailure: true })
          ]);
      const [added = "0", deleted = "0"] = numstat.stdout.trim().split(/\s+/);
      files.push({
        path: item.path,
        changeType,
        additions: Number(added) || 0,
        deletions: Number(deleted) || 0,
        diff: normalizeNoIndexDiff(diff.stdout, root)
      });
    }
    return files;
  }

  private async collectSnapshotDiff(cwd: string, touched: TouchedFile[], baseline?: WorkspaceSnapshot): Promise<GitChangedFile[]> {
    const files: GitChangedFile[] = [];
    for (const item of uniqueTouchedFiles(resolve(cwd), cwd, touched)) {
      const absolutePath = resolve(cwd, item.path);
      const info = await stat(absolutePath).catch(() => undefined);
      const before = baseline?.files.get(item.path);
      const after = info?.isFile() && info.size <= MAX_FALLBACK_TEXT_BYTES
        ? await readFile(absolutePath, "utf8").catch(() => undefined)
        : undefined;
      if (after?.includes("\0")) continue;
      if (before === undefined && after === undefined) continue;
      if (before === after) continue;
      const changeType: GitChangedFile["changeType"] = before === undefined ? "added" : after === undefined ? "deleted" : item.changeType;
      files.push(buildTextDiff(item.path, before ?? "", after ?? "", changeType));
    }
    return files;
  }
}

function uniqueTouchedFiles(root: string, cwd: string, touched: TouchedFile[]): TouchedFile[] {
  const byPath = new Map<string, TouchedFile>();
  for (const item of touched) {
    const absolute = resolve(isAbsolute(item.path) ? item.path : resolve(cwd, item.path));
    const path = relative(root, absolute).replaceAll("\\", "/");
    if (!path || path.startsWith("..") || isAbsolute(path)) continue;
    byPath.set(path, { ...item, path });
  }
  return [...byPath.values()];
}

function statusChangeType(code: string, fallback: GitChangedFile["changeType"]): GitChangedFile["changeType"] {
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code === "??" || code.includes("A")) return "added";
  if (code.trim()) return "modified";
  return fallback;
}

function normalizeNoIndexDiff(diff: string, root: string): string {
  const normalizedRoot = root.replaceAll("\\", "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return diff.replace(new RegExp(normalizedRoot, "gi"), "");
}

function buildTextDiff(path: string, before: string, after: string, changeType: GitChangedFile["changeType"]): GitChangedFile {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  const contextStart = Math.max(0, prefix - 3);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const contextBefore = oldLines.slice(contextStart, prefix).map((line) => ` ${line}`);
  const contextAfter = newLines.slice(newLines.length - suffix, newEnd).map((line) => ` ${line}`);
  const diff = [
    `diff --git a/${path} b/${path}`,
    changeType === "added" ? "new file mode 100644" : changeType === "deleted" ? "deleted file mode 100644" : "",
    changeType === "added" ? "--- /dev/null" : `--- a/${path}`,
    changeType === "deleted" ? "+++ /dev/null" : `+++ b/${path}`,
    `@@ -${contextStart + 1},${oldEnd - contextStart} +${contextStart + 1},${newEnd - contextStart} @@`,
    ...contextBefore,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...contextAfter,
    ""
  ].filter((line) => line !== "").join("\n");
  return { path, changeType, additions: added.length, deletions: removed.length, diff };
}

function splitLines(content: string): string[] {
  if (!content) return [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
