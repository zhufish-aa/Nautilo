import type { GitChangedFile } from "@agenthub/domain";
import { GitCommandRunner } from "./git-command.js";

export class ChangeCollector {
  constructor(private readonly git = new GitCommandRunner()) {}

  async collect(worktreePath: string): Promise<GitChangedFile[]> {
    const status = await this.git.run(worktreePath, ["status", "--porcelain=v1"]);
    const entries = status.stdout.split(/\r?\n/).filter(Boolean).map(parseStatus);
    const untracked = entries.filter((entry) => entry.code === "??").map((entry) => entry.path);
    if (untracked.length > 0) await this.git.run(worktreePath, ["add", "-N", "--", ...untracked]);
    return Promise.all(entries.map(async (entry): Promise<GitChangedFile> => {
      const [diff, numstat] = await Promise.all([
        this.git.run(worktreePath, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", entry.path]),
        this.git.run(worktreePath, ["diff", "--numstat", "HEAD", "--", entry.path])
      ]);
      const [added = "0", deleted = "0"] = numstat.stdout.trim().split(/\s+/);
      return {
        path: entry.path,
        changeType: changeType(entry.code),
        additions: Number(added) || 0,
        deletions: Number(deleted) || 0,
        diff: diff.stdout
      };
    }));
  }

  async collectCommitDiff(worktreePath: string, baseCommit: string, headCommit: string): Promise<string> {
    return (await this.git.run(worktreePath, ["diff", "--no-ext-diff", "--binary", baseCommit, headCommit])).stdout;
  }
}

function parseStatus(line: string): { code: string; path: string } {
  const code = line.slice(0, 2);
  const raw = line.slice(3);
  const path = (raw.includes(" -> ") ? raw.split(" -> ").at(-1)! : raw).replace(/^"|"$/g, "").replaceAll("\\", "/");
  return { code, path };
}

function changeType(code: string): GitChangedFile["changeType"] {
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code === "??" || code.includes("A")) return "added";
  return "modified";
}
