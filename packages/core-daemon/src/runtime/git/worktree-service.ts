import { existsSync, mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Project, ProjectRun, Task } from "@agenthub/domain";
import { GitCommandRunner } from "./git-command.js";
import { GitRepositoryService } from "./repository-service.js";

export interface WorktreeInfo {
  path: string;
  branchName: string;
  baseCommit: string;
}

export class WorktreeService {
  private readonly root: string;
  constructor(
    rootPath: string,
    private readonly git = new GitCommandRunner(),
    private readonly repositories = new GitRepositoryService(git)
  ) {
    this.root = resolve(rootPath);
    mkdirSync(this.root, { recursive: true });
  }

  async createRun(project: Project, projectRunId: string): Promise<WorktreeInfo> {
    const repository = await this.repositories.inspect(project.rootPath);
    if (!repository.headCommit) throw new Error(`Git repository ${project.rootPath} has no commit to use as a worktree base`);
    const branchName = `agenthub/run/${safe(projectRunId)}`;
    const path = this.target(project.id, projectRunId, "main");
    await this.add(project.rootPath, path, branchName, repository.headCommit);
    return { path, branchName, baseCommit: repository.headCommit };
  }

  async createTask(project: Project, projectRun: ProjectRun, task: Task): Promise<WorktreeInfo> {
    if (!projectRun.branchName || !projectRun.baseCommit) throw new Error(`Project run ${projectRun.id} has no Git workspace`);
    const branchName = `agenthub/task/${safe(projectRun.id)}/${safe(task.id)}`;
    const path = this.target(project.id, projectRun.id, `task-${safe(task.id)}`);
    const baseCommit = (await this.git.run(project.rootPath, ["rev-parse", projectRun.branchName])).stdout.trim();
    await this.add(project.rootPath, path, branchName, projectRun.branchName);
    return { path, branchName, baseCommit };
  }

  async commitAll(worktreePath: string, message: string): Promise<string | undefined> {
    await this.git.run(worktreePath, ["add", "-A"]);
    const status = await this.git.run(worktreePath, ["status", "--porcelain=v1"]);
    if (!status.stdout.trim()) return undefined;
    await this.git.run(worktreePath, ["-c", "user.name=AgentHub", "-c", "user.email=agenthub@local", "commit", "-m", message]);
    return (await this.git.run(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  }

  private async add(repositoryPath: string, targetPath: string, branchName: string, startPoint: string): Promise<void> {
    if (existsSync(targetPath)) {
      const current = await this.git.run(targetPath, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
      if (current.exitCode === 0) return;
      throw new Error(`Worktree target already exists and is not a Git worktree: ${targetPath}`);
    }
    mkdirSync(resolve(targetPath, ".."), { recursive: true });
    const branch = await this.git.run(repositoryPath, ["show-ref", "--verify", `refs/heads/${branchName}`], { allowFailure: true });
    await this.git.run(repositoryPath, branch.exitCode === 0
      ? ["worktree", "add", targetPath, branchName]
      : ["worktree", "add", "-b", branchName, targetPath, startPoint]);
  }

  private target(projectId: string, projectRunId: string, leaf: string): string {
    const target = resolve(this.root, safe(projectId), safe(projectRunId), leaf);
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) throw new Error("Worktree path escaped the configured root");
    return target;
  }
}

function safe(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64); }
