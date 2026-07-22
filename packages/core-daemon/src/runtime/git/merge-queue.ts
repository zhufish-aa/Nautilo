import type { GitConflict } from "@agenthub/domain";
import { GitCommandRunner } from "./git-command.js";

export type MergeResult =
  | { merged: true; commit: string; previousCommit: string }
  | { merged: false; conflicts: GitConflict[] };

export class MergeQueue {
  constructor(private readonly git = new GitCommandRunner()) {}

  async mergeTask(targetWorktree: string, sourceBranch: string, targetBranch: string): Promise<MergeResult> {
    return this.merge(targetWorktree, sourceBranch, targetBranch, "task_merge");
  }

  async mergeFinal(repositoryPath: string, sourceBranch: string, targetBranch: string): Promise<MergeResult> {
    const status = await this.git.run(repositoryPath, ["status", "--porcelain=v1"]);
    if (status.stdout.trim()) {
      return { merged: false, conflicts: status.stdout.split(/\r?\n/).filter(Boolean).map((line) => ({ path: line.slice(3), operation: "final_merge", sourceBranch, targetBranch })) };
    }
    return this.merge(repositoryPath, sourceBranch, targetBranch, "final_merge");
  }

  async rollback(targetPath: string, commit: string): Promise<void> {
    await this.git.run(targetPath, ["reset", "--hard", commit]);
  }

  private async merge(targetPath: string, sourceBranch: string, targetBranch: string, operation: GitConflict["operation"]): Promise<MergeResult> {
    const previousCommit = (await this.git.run(targetPath, ["rev-parse", "HEAD"])).stdout.trim();
    const result = await this.git.run(targetPath, ["-c", "user.name=AgentHub", "-c", "user.email=agenthub@local", "merge", "--no-ff", "--no-edit", sourceBranch], { allowFailure: true });
    if (result.exitCode === 0) {
      return { merged: true, commit: (await this.git.run(targetPath, ["rev-parse", "HEAD"])).stdout.trim(), previousCommit };
    }
    const conflicts = (await this.git.run(targetPath, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true })).stdout.split(/\r?\n/).filter(Boolean);
    await this.git.run(targetPath, ["merge", "--abort"], { allowFailure: true });
    return { merged: false, conflicts: (conflicts.length ? conflicts : ["unknown"]).map((path) => ({ path, operation, sourceBranch, targetBranch })) };
  }
}
