import type { Artifact, GitChangedFile, ProjectRun, Session, Task, VerificationResult } from "@agenthub/domain";
import { Database } from "../database/index.js";
import { CoreError } from "../errors.js";
import { EventService } from "./event-service.js";
import { ArtifactService } from "./artifact-service.js";
import { VerificationEngine } from "./verification-engine.js";
import { ChangeCollector, GitRepositoryService, MergeQueue, PathPolicy, WorktreeService } from "./git/index.js";
import { RedactionService } from "./security/redaction-service.js";

export type TaskFinalizeResult =
  | { ok: true; task: Task; files: GitChangedFile[]; verificationResults: VerificationResult[]; mergeCommit?: string }
  | { ok: false; task: Task; reason: "path" | "verification" | "conflict"; message: string; files: GitChangedFile[]; verificationResults: VerificationResult[] };

export interface RunFinalizeResult {
  projectRun: ProjectRun;
  files: GitChangedFile[];
  verificationResults: VerificationResult[];
  needsMergeApproval: boolean;
}

/** Git/verification use cases used by orchestration; no planner/provider logic. */
export class GitWorkflowService {
  private readonly worktrees: WorktreeService;
  private readonly changes = new ChangeCollector();
  private readonly paths = new PathPolicy();
  private readonly merges = new MergeQueue();
  private readonly repositories = new GitRepositoryService();
  private readonly artifacts: ArtifactService;
  private readonly verification: VerificationEngine;

  constructor(
    private readonly database: Database,
    private readonly events: EventService,
    worktreeRoot: string,
    redaction = new RedactionService()
  ) {
    this.worktrees = new WorktreeService(worktreeRoot);
    this.artifacts = new ArtifactService(database);
    this.verification = new VerificationEngine(database, redaction);
  }

  async initializeRun(projectRun: ProjectRun): Promise<ProjectRun> {
    const project = this.requireProject(projectRun.projectId);
    if (projectRun.workspaceMode !== "git_isolated" || project.repositoryType !== "git") {
      return this.withSharedWorkspace(projectRun, project.rootPath);
    }
    try {
      const repository = await this.repositories.inspect(project.rootPath);
      if (!repository.headCommit) return this.withSharedWorkspace(projectRun, project.rootPath);
      const info = await this.worktrees.createRun(project, projectRun.id);
      return { ...projectRun, workspacePath: info.path, branchName: info.branchName, baseCommit: info.baseCommit, baseBranch: repository.branch };
    } catch {
      // Git is an optional isolation capability. A stale repository setting,
      // an unborn branch, or an unavailable worktree must not prevent the
      // Agent from handling chat, media, planning, or other local tasks.
      return this.withSharedWorkspace(projectRun, project.rootPath);
    }
  }

  async initializeTask(projectRun: ProjectRun, task: Task): Promise<Task> {
    const project = this.requireProject(projectRun.projectId);
    const sharedWorkspace = projectRun.workspacePath ?? project.rootPath;
    if (projectRun.workspaceMode !== "git_isolated" || project.repositoryType !== "git" || !projectRun.branchName || !projectRun.baseCommit) {
      return { ...task, workspacePath: sharedWorkspace, updatedAt: new Date().toISOString() };
    }
    try {
      const info = await this.worktrees.createTask(project, projectRun, task);
      return { ...task, workspacePath: info.path, branchName: info.branchName, baseCommit: info.baseCommit, updatedAt: new Date().toISOString() };
    } catch {
      return { ...task, workspacePath: sharedWorkspace, updatedAt: new Date().toISOString() };
    }
  }

  workingDirectory(projectRun: ProjectRun, task?: Task): string {
    return task?.workspacePath ?? projectRun.workspacePath ?? this.requireProject(projectRun.projectId).rootPath;
  }

  async finalizeTask(projectRun: ProjectRun, task: Task, taskSession: Session, mainSession: Session): Promise<TaskFinalizeResult> {
    const project = this.requireProject(projectRun.projectId);
    if (projectRun.workspaceMode !== "git_isolated" || project.repositoryType !== "git" || !task.workspacePath || !task.branchName || !projectRun.workspacePath || !projectRun.branchName) {
      const verificationResults = await this.verify(project, task.workspacePath ?? project.rootPath, taskSession, projectRun.id, task.id, "task", task.acceptanceCriteria.flatMap((criterion) => criterion.commandTemplateId ? [criterion.commandTemplateId] : []));
      return this.verification.passed(verificationResults)
        ? { ok: true, task, files: [], verificationResults }
        : { ok: false, task, reason: "verification", message: "Required verification failed", files: [], verificationResults };
    }

    const files = await this.changes.collect(task.workspacePath);
    const violations = this.paths.validate(task.workspacePath, files.map((file) => file.path), task.allowedPaths);
    const diffArtifact = files.length ? this.saveDiff(projectRun.id, task.id, taskSession.id, task.title, files) : undefined;
    this.emitFiles(taskSession, projectRun.id, task.id, files, diffArtifact);
    if (violations.length > 0) {
      return { ok: false, task: { ...task, diffArtifactId: diffArtifact?.id, pathViolations: violations }, reason: "path", message: `Changed paths are outside allowedPaths: ${violations.join(", ")}`, files, verificationResults: [] };
    }

    const templateIds = task.acceptanceCriteria.flatMap((criterion) => criterion.commandTemplateId ? [criterion.commandTemplateId] : []);
    const verificationResults = await this.verify(project, task.workspacePath, taskSession, projectRun.id, task.id, "task", templateIds);
    if (!this.verification.passed(verificationResults)) {
      return { ok: false, task: { ...task, diffArtifactId: diffArtifact?.id, verificationResultIds: verificationResults.map((item) => item.id) }, reason: "verification", message: "Required task verification failed", files, verificationResults };
    }

    const resultCommit = await this.worktrees.commitAll(task.workspacePath, `agenthub(${task.id}): ${task.title}`) ?? task.resultCommit;
    if (!resultCommit) return { ok: true, task: { ...task, diffArtifactId: diffArtifact?.id, verificationResultIds: verificationResults.map((item) => item.id) }, files, verificationResults };
    if (task.baseCommit) await this.saveCommitDiff(projectRun.id, task.id, taskSession.id, task.title, task.workspacePath, task.baseCommit, resultCommit);
    this.events.appendForSession(mainSession, { projectRunId: projectRun.id, taskId: task.id }, "git.merge_started", { sourceBranch: task.branchName, targetBranch: projectRun.branchName, taskId: task.id });
    const merged = await this.merges.mergeTask(projectRun.workspacePath, task.branchName, projectRun.branchName);
    if (!merged.merged) {
      this.events.appendForSession(mainSession, { projectRunId: projectRun.id, taskId: task.id }, "git.conflict", { sourceBranch: task.branchName, targetBranch: projectRun.branchName, paths: merged.conflicts.map((item) => item.path), taskId: task.id });
      return { ok: false, task: { ...task, resultCommit, diffArtifactId: diffArtifact?.id, conflicts: merged.conflicts, verificationResultIds: verificationResults.map((item) => item.id) }, reason: "conflict", message: `Merge conflict: ${merged.conflicts.map((item) => item.path).join(", ")}`, files, verificationResults };
    }

    const mergeVerification = await this.verify(project, projectRun.workspacePath, mainSession, projectRun.id, task.id, "merge");
    if (!this.verification.passed(mergeVerification)) {
      await this.merges.rollback(projectRun.workspacePath, merged.previousCommit);
      return { ok: false, task: { ...task, resultCommit, diffArtifactId: diffArtifact?.id, verificationResultIds: [...verificationResults, ...mergeVerification].map((item) => item.id) }, reason: "verification", message: "Post-merge verification failed; isolated run branch was rolled back", files, verificationResults: [...verificationResults, ...mergeVerification] };
    }
    this.events.appendForSession(mainSession, { projectRunId: projectRun.id, taskId: task.id }, "git.merge_finished", { sourceBranch: task.branchName, targetBranch: projectRun.branchName, commit: merged.commit, taskId: task.id });
    return { ok: true, task: { ...task, resultCommit, diffArtifactId: diffArtifact?.id, verificationResultIds: [...verificationResults, ...mergeVerification].map((item) => item.id) }, files, verificationResults: [...verificationResults, ...mergeVerification], mergeCommit: merged.commit };
  }

  async finalizeRun(projectRun: ProjectRun, mainSession: Session): Promise<RunFinalizeResult> {
    const project = this.requireProject(projectRun.projectId);
    const workspace = this.workingDirectory(projectRun);
    const isolatedGitRun = projectRun.workspaceMode === "git_isolated" && project.repositoryType === "git" && !!projectRun.baseCommit && !!projectRun.branchName;
    const files = isolatedGitRun ? await this.changes.collect(workspace) : [];
    const diffArtifact = files.length ? this.saveDiff(projectRun.id, undefined, mainSession.id, projectRun.goal, files) : undefined;
    this.emitFiles(mainSession, projectRun.id, undefined, files, diffArtifact);
    const verificationResults = await this.verify(project, workspace, mainSession, projectRun.id, undefined, "run");
    if (!this.verification.passed(verificationResults)) throw new CoreError("VERIFICATION_FAILED", { projectRunId: projectRun.id });
    // Never create a first commit or commit the user's shared working tree as
    // a side effect of the non-isolated fallback.
    const resultCommit = isolatedGitRun ? await this.worktrees.commitAll(workspace, `agenthub: ${projectRun.goal.slice(0, 72)}`) : undefined;
    const head = isolatedGitRun ? (await this.repositories.inspect(workspace)).headCommit : undefined;
    if (projectRun.baseCommit && head && head !== projectRun.baseCommit) {
      await this.saveCommitDiff(projectRun.id, undefined, mainSession.id, projectRun.goal, workspace, projectRun.baseCommit, head);
    }
    const needsMergeApproval = !!(projectRun.baseCommit && head && head !== projectRun.baseCommit);
    return { projectRun: { ...projectRun, resultCommit: resultCommit ?? head }, files, verificationResults, needsMergeApproval };
  }

  async mergeFinal(projectRun: ProjectRun, mainSession: Session): Promise<ProjectRun> {
    const project = this.requireProject(projectRun.projectId);
    if (projectRun.workspaceMode !== "git_isolated" || project.repositoryType !== "git" || !projectRun.branchName || !projectRun.baseBranch) return projectRun;
    const repository = await this.repositories.inspect(project.rootPath);
    if (repository.branch !== projectRun.baseBranch) throw new CoreError("MERGE_CONFLICT", { reason: "base_branch_changed", expected: projectRun.baseBranch, actual: repository.branch });
    this.events.appendForSession(mainSession, { projectRunId: projectRun.id }, "git.merge_started", { sourceBranch: projectRun.branchName, targetBranch: projectRun.baseBranch });
    const result = await this.merges.mergeFinal(project.rootPath, projectRun.branchName, projectRun.baseBranch);
    if (!result.merged) {
      this.events.appendForSession(mainSession, { projectRunId: projectRun.id }, "git.conflict", { sourceBranch: projectRun.branchName, targetBranch: projectRun.baseBranch, paths: result.conflicts.map((item) => item.path) });
      return { ...projectRun, conflicts: result.conflicts };
    }
    this.events.appendForSession(mainSession, { projectRunId: projectRun.id }, "git.merge_finished", { sourceBranch: projectRun.branchName, targetBranch: projectRun.baseBranch, commit: result.commit });
    return { ...projectRun, resultCommit: result.commit, conflicts: undefined };
  }

  private async verify(project: ReturnType<GitWorkflowService["requireProject"]>, workspace: string, session: Session, projectRunId: string, taskId: string | undefined, scope: "task" | "run" | "merge", templateIds?: string[]): Promise<VerificationResult[]> {
    return this.verification.run(project, workspace, {
      projectRunId, taskId, sessionId: session.id, scope, templateIds: templateIds?.length ? templateIds : undefined,
      onStarted: (template, verificationId) => this.events.appendForSession(session, { projectRunId, taskId }, "verification.started", { verificationId, commandTemplateId: template.id }),
      onFinished: (result) => this.events.appendForSession(session, { projectRunId, taskId }, "verification.finished", { verificationId: result.id, passed: result.passed, exitCode: result.exitCode, durationMs: result.durationMs, outputArtifactId: result.outputArtifactId })
    });
  }

  private withSharedWorkspace(projectRun: ProjectRun, rootPath: string): ProjectRun {
    return {
      ...projectRun,
      workspacePath: rootPath,
      branchName: undefined,
      baseCommit: undefined,
      baseBranch: undefined
    };
  }

  private saveDiff(projectRunId: string, taskId: string | undefined, sessionId: string, name: string, files: GitChangedFile[]): Artifact {
    return this.artifacts.save({
      kind: "diff",
      name: `${name.slice(0, 80)}.diff.json`,
      content: JSON.stringify({ files }),
      projectRunId,
      taskId,
      sessionId,
      metadata: { paths: files.map((file) => file.path), fileCount: files.length }
    });
  }

  private async saveCommitDiff(projectRunId: string, taskId: string | undefined, sessionId: string, name: string, workspace: string, baseCommit: string, headCommit: string): Promise<Artifact> {
    const content = await this.changes.collectCommitDiff(workspace, baseCommit, headCommit);
    return this.artifacts.save({
      kind: "commit",
      name: `${name.slice(0, 80)}.patch`,
      content,
      projectRunId,
      taskId,
      sessionId,
      metadata: { baseCommit, headCommit }
    });
  }

  private emitFiles(session: Session, projectRunId: string, taskId: string | undefined, files: GitChangedFile[], artifact?: Artifact): void {
    for (const file of files) this.events.appendForSession(session, { projectRunId, taskId }, "file.changed", { path: file.path, changeType: file.changeType });
    if (artifact) this.events.appendForSession(session, { projectRunId, taskId }, "git.diff_collected", { artifactId: artifact.id, taskId, fileCount: files.length });
  }

  private requireProject(projectId: string) {
    const project = this.database.projects.get(projectId);
    if (!project) throw new CoreError("IPC_NOT_FOUND", { resource: "project", id: projectId });
    return project;
  }
}
