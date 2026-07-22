import { GitCommandRunner } from "./git-command.js";

export interface GitRepositoryState {
  rootPath: string;
  branch: string;
  defaultBranch: string;
  /** Undefined for an initialized repository that does not have its first commit yet. */
  headCommit?: string;
  dirtyPaths: string[];
}

export class GitRepositoryService {
  constructor(private readonly git = new GitCommandRunner()) {}

  async inspect(rootPath: string): Promise<GitRepositoryState> {
    const top = await this.git.run(rootPath, ["rev-parse", "--show-toplevel"]);
    const branch = (await this.git.run(rootPath, ["branch", "--show-current"])).stdout.trim();
    const head = await this.git.run(rootPath, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
    const headCommit = head.exitCode === 0 ? head.stdout.trim() : undefined;
    const remoteHead = await this.git.run(rootPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { allowFailure: true });
    const status = await this.git.run(rootPath, ["status", "--porcelain=v1"]);
    return {
      rootPath: top.stdout.trim(),
      branch,
      defaultBranch: remoteHead.exitCode === 0 ? remoteHead.stdout.trim().replace(/^origin\//, "") : branch,
      headCommit,
      dirtyPaths: status.stdout.split(/\r?\n/).filter(Boolean).map((line) => normalizeStatusPath(line.slice(3)))
    };
  }
}

function normalizeStatusPath(value: string): string {
  const target = value.includes(" -> ") ? value.split(" -> ").at(-1)! : value;
  return target.replace(/^"|"$/g, "").replaceAll("\\", "/");
}
