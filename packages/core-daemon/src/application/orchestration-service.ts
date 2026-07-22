import { randomUUID } from "node:crypto";
import type {
  PlannerDecision,
  ProjectRun,
  Session,
  Task,
  TeamDefinition,
  ApprovalScope
} from "@agenthub/domain";
import { canTransitionProjectRun } from "@agenthub/domain";
import { Database } from "../database/index.js";
import { CoreError, toAgentHubError } from "../errors.js";
import { EventService } from "../runtime/event-service.js";
import {
  DecisionValidator,
  ConversationContinuityBuilder,
  extractJsonObject,
  MemberRouter,
  MessageRouter,
  OrchestrationPromptBuilder,
  SessionRouter,
  TaskGraph,
  type DelegationReceipt
} from "../runtime/orchestration/index.js";
import { RunService, type RunCompletion } from "../runtime/run-service.js";
import { GitWorkflowService } from "../runtime/git-workflow-service.js";
import { ApprovalService } from "../runtime/security/approval-service.js";
import type { MessageAttachmentInput } from "@agenthub/schemas";
import { MessageAttachmentService } from "../runtime/message-attachment-service.js";

export interface StartOrchestrationInput {
  projectId: string;
  teamId: string;
  agentInstanceId?: string;
  goal: string;
  sessionId?: string;
  attachments?: MessageAttachmentInput[];
}

export interface StartOrchestrationResult {
  projectRun: ProjectRun;
  mainSession: Session;
}

interface TaskLaunch {
  receipt: Promise<DelegationReceipt>;
  execution: Promise<void>;
}

/** Coordinates decisions and task execution; provider/process details stay in RunService. */
export class OrchestrationService {
  private readonly members: MemberRouter;
  private readonly decisions: DecisionValidator;
  private readonly prompts = new OrchestrationPromptBuilder();
  private readonly graph: TaskGraph;
  private readonly sessionRouter: SessionRouter;
  private readonly messages: MessageRouter;
  private readonly continuity = new ConversationContinuityBuilder();
  private readonly attachments: MessageAttachmentService;
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    private readonly database: Database,
    private readonly runs: RunService,
    private readonly events: EventService,
    private readonly gitWorkflows?: GitWorkflowService,
    private readonly approvals?: ApprovalService
  ) {
    this.members = new MemberRouter(database);
    this.decisions = new DecisionValidator(this.members);
    this.graph = new TaskGraph(database);
    this.sessionRouter = new SessionRouter(database);
    this.messages = new MessageRouter(database);
    this.attachments = new MessageAttachmentService(database);
  }

  start(input: StartOrchestrationInput): StartOrchestrationResult {
    const project = this.database.projects.get(input.projectId);
    if (!project) throw new CoreError("IPC_NOT_FOUND", { resource: "project", id: input.projectId });
    const team = this.requireTeam(input.teamId);
    const main = this.members.sessionMain(team, input.agentInstanceId);
    if (!input.goal.trim()) throw new CoreError("IPC_INVALID_REQUEST", { field: "goal" });

    const now = new Date().toISOString();
    let projectRun: ProjectRun = {
      id: randomUUID(),
      projectId: input.projectId,
      teamId: team.id,
      goal: input.goal.trim(),
      mainMemberId: main.member.id,
      mainAgentInstanceId: main.agent.id,
      status: "planning",
      createdAt: now,
      updatedAt: now
    };
    const mainSession = this.sessionRouter.main(projectRun, team, input.sessionId);
    projectRun = { ...projectRun, mainSessionId: mainSession.id };
    this.database.projectRuns.save(projectRun);
    const userMessage = this.messages.userGoal(mainSession, projectRun);
    this.schedule(projectRun.id, async () => {
      const attachments = await this.attachments.save(mainSession, input.attachments);
      if (attachments.length) {
        this.database.sessions.saveMessage({ ...userMessage, attachmentIds: attachments.map((artifact) => artifact.id) });
      }
      if (this.gitWorkflows) this.saveProjectRun(await this.gitWorkflows.initializeRun(this.requireProjectRun(projectRun.id)));
      await this.plan(projectRun.id);
    });
    return { projectRun, mainSession };
  }

  get(projectRunId: string): StartOrchestrationResult {
    const projectRun = this.requireProjectRun(projectRunId);
    const mainSession = this.requireMainSession(projectRun);
    return { projectRun, mainSession };
  }

  resolveDelegation(projectRunId: string, approved: boolean, scope: ApprovalScope = "run"): ProjectRun {
    const projectRun = this.requireProjectRun(projectRunId);
    if (projectRun.status !== "waiting_user" || !projectRun.pendingApprovalId || !projectRun.plannerDecision || projectRun.plannerDecision.mode === "direct") {
      throw new CoreError("PLAN_APPROVAL_NOT_FOUND", { projectRunId });
    }
    const mainSession = this.requireMainSession(projectRun);
    this.approvals?.resolve(projectRun.pendingApprovalId, approved ? "approved" : "rejected", scope);
    this.events.appendForSession(mainSession, { projectRunId }, "approval.resolved", {
      approvalId: projectRun.pendingApprovalId,
      decision: approved ? "approved" : "rejected",
      scope
    });

    if (approved) {
      this.graph.releaseApproval(projectRunId);
      const executing = this.saveProjectRun({ ...projectRun, status: "executing", pendingApprovalId: undefined });
      this.schedule(projectRunId, () => this.executeTasks(projectRunId));
      return executing;
    }

    for (const task of this.database.tasks.list(projectRunId)) this.updateTask(mainSession, task, "cancelled");
    const executing = this.saveProjectRun({ ...projectRun, status: "executing", pendingApprovalId: undefined });
    this.schedule(projectRunId, () => this.executeDirect(projectRunId, true));
    return executing;
  }

  async resolveMerge(projectRunId: string, approved: boolean, scope: ApprovalScope = "project"): Promise<ProjectRun> {
    const projectRun = this.requireProjectRun(projectRunId);
    if (projectRun.status !== "merge_ready" || !projectRun.mergeApprovalId || !this.gitWorkflows) {
      throw new CoreError("PLAN_APPROVAL_NOT_FOUND", { projectRunId, category: "merge" });
    }
    const mainSession = this.requireMainSession(projectRun);
    this.approvals?.resolve(projectRun.mergeApprovalId, approved ? "approved" : "rejected", scope);
    this.events.appendForSession(mainSession, { projectRunId }, "approval.resolved", {
      approvalId: projectRun.mergeApprovalId,
      decision: approved ? "approved" : "rejected",
      scope
    });
    if (!approved) return this.saveProjectRun({ ...projectRun, status: "review_required", mergeApprovalId: undefined });
    this.saveProjectRun({ ...projectRun, status: "merging", mergeApprovalId: undefined });
    const merged = await this.gitWorkflows.mergeFinal(this.requireProjectRun(projectRunId), mainSession);
    if (merged.conflicts?.length) return this.saveProjectRun({ ...merged, status: "review_required" });
    return this.saveProjectRun({ ...merged, status: "completed" });
  }

  async cancel(projectRunId: string): Promise<ProjectRun> {
    const projectRun = this.requireProjectRun(projectRunId);
    await this.runs.cancelProjectRun(projectRunId);
    const mainSession = this.requireMainSession(projectRun);
    for (const task of this.database.tasks.list(projectRunId)) {
      if (!["completed", "cancelled"].includes(task.status)) this.updateTask(mainSession, task, "cancelled");
    }
    return this.saveProjectRun({ ...this.requireProjectRun(projectRunId), status: "cancelled" });
  }

  recover(projectRunId: string, memberId: string, mode: "resume" | "replace"): ProjectRun {
    const projectRun = this.requireProjectRun(projectRunId);
    if (!["paused", "failed"].includes(projectRun.status)) throw new CoreError("RECOVERY_NOT_AVAILABLE", { projectRunId, status: projectRun.status });
    const team = this.requireTeam(String(projectRun.teamId));
    const previousSession = this.requireMainSession(projectRun);
    if (mode === "resume" && memberId !== projectRun.mainMemberId) throw new CoreError("RECOVERY_NOT_AVAILABLE", { reason: "resume_requires_same_member" });
    const replacement = mode === "replace" ? this.members.resolve(team, memberId) : undefined;
    const mainSession = mode === "resume"
      ? { ...previousSession, status: "idle" as const, updatedAt: new Date().toISOString() }
      : this.sessionRouter.replacementMain(projectRun, team, memberId, previousSession);
    this.database.sessions.save(mainSession);
    for (const task of this.database.tasks.list(projectRunId)) {
      if (!["completed", "cancelled"].includes(task.status)) {
        const cancelled = { ...task, status: "cancelled" as const, updatedAt: new Date().toISOString() };
        this.database.tasks.save(cancelled);
        this.emitTask(mainSession, cancelled);
      }
    }
    const recovered = this.saveProjectRun({
      ...projectRun,
      mainMemberId: memberId,
      mainAgentInstanceId: replacement?.agent.id ?? projectRun.mainAgentInstanceId,
      mainSessionId: mainSession.id,
      status: "planning",
      recoveryReason: mode === "resume" ? "provider_session_resume" : "main_agent_replaced",
      previousMainMemberIds: [...(projectRun.previousMainMemberIds ?? []), projectRun.mainMemberId]
    });
    this.messages.system(
      mainSession,
      recovered,
      mode === "resume" ? "已恢复原主 Agent 会话，将重新规划未完成目标。" : `主 Agent 已切换为 ${memberId}，将重新规划未完成目标。`,
      "recovery"
    );
    this.schedule(projectRunId, () => this.plan(projectRunId));
    return recovered;
  }

  async wait(projectRunId: string): Promise<void> {
    await this.active.get(projectRunId);
  }

  private async plan(projectRunId: string): Promise<void> {
    const projectRun = this.requireProjectRun(projectRunId);
    const team = this.requireTeam(String(projectRun.teamId));
    const main = this.members.sessionMain(team, projectRun.mainAgentInstanceId);
    const mainSession = this.requireMainSession(projectRun);
    const childSessions = this.database.sessions.list(projectRun.projectId)
      .filter((session) => session.parentSessionId === mainSession.id)
      .filter((session) => team.members.some((member) => member.enabled && member.id === session.memberId));
    const previousArtifacts = this.database.projectRuns.list(projectRun.projectId)
      .filter((run) => run.id !== projectRun.id)
      .reverse()
      .flatMap((run) => this.database.artifacts.list({ projectRunId: run.id }));
    const currentArtifacts = this.database.artifacts.list({ projectRunId: projectRun.id });
    const continuity = this.continuity.build({
      currentProjectRunId: projectRun.id,
      currentText: projectRun.goal,
      messages: this.database.sessions.messages(mainSession.id),
      artifacts: [...previousArtifacts, ...currentArtifacts],
      recoverProviderContext: !mainSession.providerSessionId || !mainSession.providerContextSyncedAt
    });
    const handle = await this.runs.launch(
      mainSession,
      main.agent,
      this.prompts.planning(projectRun.goal, team, childSessions, continuity.prompt),
      { projectRunId, memberId: main.member.id, messageKind: "planner_decision", workingDirectory: this.workingDirectory(projectRun), localImagePaths: continuity.localImagePaths }
    );
    const completion = await handle.completion;
    this.assertCompleted(completion, "main Agent planning");
    const decision = this.decisions.planner(extractJsonObject(completion.finalMessage ?? ""), team);
    const taskIds = decision.mode === "direct" ? undefined : decision.mode === "delegate" ? [decision.task.id] : decision.tasks.map((task) => task.id);
    this.events.append(mainSession, completion.run, "planner.decision", { mode: decision.mode, rationale: decision.rationale, taskIds });
    this.saveProjectRun({ ...projectRun, plannerDecision: decision, updatedAt: new Date().toISOString() });

    if (decision.mode === "direct") {
      await this.executeDirect(projectRunId);
      return;
    }

    const plannedTasks = decision.mode === "delegate" ? [decision.task] : decision.tasks;
    const approvalRequired = team.delegationPolicy === "ask_before_delegate";
    this.graph.create(projectRunId, plannedTasks, approvalRequired);
    for (const task of this.database.tasks.list(projectRunId)) this.emitTask(mainSession, task);

    if (approvalRequired) {
      const approvalId = randomUUID();
      this.approvals?.request({ id: approvalId, category: "delegate", operation: "orchestration.delegate", summary: `Delegate planned tasks for ${projectRun.goal}`, projectId: projectRun.projectId, projectRunId, sessionId: mainSession.id, requestedBy: projectRun.mainMemberId });
      this.saveProjectRun({ ...this.requireProjectRun(projectRunId), status: "waiting_user", pendingApprovalId: approvalId });
      this.events.appendForSession(mainSession, { projectRunId, runId: completion.run.id }, "approval.requested", {
        approvalId,
        category: "delegate",
        summary: `${plannedTasks.length} delegated task${plannedTasks.length === 1 ? "" : "s"}: ${decision.rationale}`
      });
      this.events.appendForSession(mainSession, { projectRunId, runId: completion.run.id }, "run.waiting", { reason: "approval" });
      return;
    }

    this.saveProjectRun({ ...this.requireProjectRun(projectRunId), status: "executing" });
    await this.executeTasks(projectRunId);
  }

  private async executeDirect(projectRunId: string, delegationRejected = false): Promise<void> {
    const projectRun = this.requireProjectRun(projectRunId);
    const team = this.requireTeam(String(projectRun.teamId));
    const main = this.members.sessionMain(team, projectRun.mainAgentInstanceId);
    const mainSession = this.requireMainSession(projectRun);
    this.saveProjectRun({ ...projectRun, status: "executing" });
    const prompt = delegationRejected ? this.prompts.delegationRejected(projectRun.goal) : this.prompts.directExecution(projectRun.goal);
    const handle = await this.runs.launch(mainSession, main.agent, prompt, { projectRunId, memberId: main.member.id, workingDirectory: this.workingDirectory(projectRun) });
    const completion = await handle.completion;
    this.assertCompleted(completion, "direct execution");
    await this.finishRun(projectRunId, mainSession);
  }

  private async executeTasks(projectRunId: string): Promise<void> {
    const projectRun = this.requireProjectRun(projectRunId);
    const team = this.requireTeam(String(projectRun.teamId));
    const mainSession = this.requireMainSession(projectRun);

    while (true) {
      const ready = this.graph.ready(projectRunId);
      if (ready.length === 0) break;
      const memberCounts = new Map<string, number>();
      const wave = ready.filter((task) => {
        const member = team.members.find((candidate) => candidate.id === task.assignedMemberId);
        const limit = Math.max(1, member?.maxConcurrentTasks ?? 1);
        const count = memberCounts.get(String(task.assignedMemberId)) ?? 0;
        if (count >= limit) return false;
        memberCounts.set(String(task.assignedMemberId), count + 1);
        return true;
      });
      const launchable = wave.length ? wave : [ready[0]!];
      const launches = launchable.map((task) => this.launchTask(
        this.requireProjectRun(projectRunId),
        team,
        mainSession,
        task
      ));

      // `runs.launch` has accepted every task in this dependency wave. Feed
      // that receipt back into the parent provider session before awaiting any
      // child completion, matching an asynchronous sub-Agent tool call.
      const receipts = await this.waitForDispatchReceipts(launches);
      const childReceipts = receipts.filter((receipt) => receipt.sessionId !== mainSession.id);
      let continuationError: unknown;
      try {
        if (childReceipts.length) await this.continueAfterDelegation(projectRunId, childReceipts);
      } catch (error) {
        continuationError = error;
      }

      const outcomes = await Promise.allSettled(launches.map((item) => item.execution));
      if (continuationError) throw continuationError;
      const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      if (failed) throw failed.reason;
    }

    const tasks = this.database.tasks.list(projectRunId);
    const unresolved = tasks.filter((task) => !["completed", "failed", "cancelled", "blocked_dependency"].includes(task.status));
    if (unresolved.length > 0) throw new CoreError("RECOVERY_REQUIRED", { projectRunId, taskIds: unresolved.map((task) => task.id) });

    // A task assigned to the main Agent already produced its user-facing result
    // in that provider turn. Another synthesis would only duplicate the answer.
    if (tasks.length === 1 && tasks[0]?.status === "completed" && tasks[0].completedByMemberId === projectRun.mainMemberId) {
      await this.finishRun(projectRunId, mainSession);
      return;
    }

    const resultMessages = this.database.sessions.messages(mainSession.id)
      .filter((message) => message.projectRunId === projectRunId && message.kind === "result" && message.sender === "system" && message.taskId);
    const results = tasks.map((task) => {
      const message = [...resultMessages].reverse().find((candidate) => candidate.taskId === task.id);
      const member = team.members.find((candidate) => candidate.id === task.assignedMemberId);
      return { taskId: task.id, memberName: member?.displayName, result: message?.text };
    });
    const main = this.members.sessionMain(team, projectRun.mainAgentInstanceId);
    const handle = await this.runs.launch(
      this.requireMainSession(this.requireProjectRun(projectRunId)),
      main.agent,
      this.prompts.finalSynthesis(projectRun.goal, tasks, results),
      { projectRunId, memberId: main.member.id, workingDirectory: this.workingDirectory(this.requireProjectRun(projectRunId)) }
    );
    const completion = await handle.completion;
    this.assertCompleted(completion, "final synthesis");

    const latestRun = this.requireProjectRun(projectRunId);
    const failedTaskIds = tasks
      .filter((task) => task.status === "failed")
      .map((task) => task.id);
    if (failedTaskIds.length > 0) {
      this.saveProjectRun({
        ...latestRun,
        status: "failed",
        recoveryReason: `delegated_tasks_failed:${failedTaskIds.join(",")}`
      });
      return;
    }

    await this.finishRun(projectRunId, mainSession);
  }

  private launchTask(projectRun: ProjectRun, team: TeamDefinition, mainSession: Session, task: Task): TaskLaunch {
    let resolveReceipt!: (receipt: DelegationReceipt) => void;
    let rejectReceipt!: (error: unknown) => void;
    let dispatched = false;
    const receipt = new Promise<DelegationReceipt>((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });
    const execution = this.executeTask(projectRun, team, mainSession, task, (value) => {
      dispatched = true;
      resolveReceipt(value);
    }).catch((error) => {
      if (!dispatched) rejectReceipt(error);
      throw error;
    });

    // Receipt validation can fail before executeTasks reaches the completion
    // barrier. Attach a handler immediately so Node never observes a detached
    // rejected task promise; the original rejection is still inspected later.
    void execution.catch(() => undefined);
    return { receipt, execution };
  }

  private async waitForDispatchReceipts(launches: TaskLaunch[]): Promise<DelegationReceipt[]> {
    try {
      return await Promise.all(launches.map((item) => item.receipt));
    } catch (error) {
      await Promise.allSettled(launches.map((item) => item.execution));
      throw error;
    }
  }

  private async executeTask(
    projectRun: ProjectRun,
    team: TeamDefinition,
    mainSession: Session,
    task: Task,
    onDispatched?: (receipt: DelegationReceipt) => void
  ): Promise<void> {
    if (this.gitWorkflows && !task.workspacePath) {
      task = await this.gitWorkflows.initializeTask(projectRun, task);
      this.database.tasks.save(task);
    }
    const assigned = this.members.resolve(team, String(task.assignedMemberId), task.taskType);
    const isMain = assigned.member.id === projectRun.mainMemberId;
    const taskSession = isMain
      ? mainSession
      : this.sessionRouter.delegated(projectRun, team, assigned.member, mainSession, task.id, task.title, task.targetSessionId);

    if (!isMain) {
      this.messages.delegation(mainSession, taskSession, projectRun, task);
      this.events.appendForSession(mainSession, { projectRunId: projectRun.id, taskId: task.id }, "handoff.created", {
        fromMemberId: projectRun.mainMemberId,
        toMemberId: assigned.member.id,
        summary: task.title,
        artifactIds: [],
        taskId: task.id,
        targetSessionId: taskSession.id
      });
    }

    let currentTask = this.updateTask(mainSession, task, "queued");
    currentTask = this.updateTask(mainSession, currentTask, "running");
    const handle = await this.runs.launch(
      taskSession,
      assigned.agent,
      this.prompts.delegatedTask(currentTask, team),
      { projectRunId: projectRun.id, taskId: task.id, memberId: assigned.member.id, workingDirectory: this.workingDirectory(projectRun, currentTask) }
    );
    onDispatched?.({
      taskId: currentTask.id,
      title: currentTask.title,
      assignedMemberId: assigned.member.id,
      memberName: assigned.member.displayName,
      sessionId: taskSession.id,
      runId: handle.runId
    });
    const completion = await handle.completion;

    if (completion.run.status === "completed") {
      if (this.gitWorkflows) {
        currentTask = this.updateTask(mainSession, currentTask, "verifying");
        const finalized = await this.gitWorkflows.finalizeTask(this.requireProjectRun(projectRun.id), currentTask, taskSession, mainSession);
        if (!finalized.ok) {
          currentTask = this.updateTask(mainSession, currentTask, "failed", finalized.task);
          if (finalized.reason === "path") this.messages.system(mainSession, projectRun, `PATH_POLICY_VIOLATION: ${finalized.message}`, "recovery");
          if (finalized.reason === "conflict") this.messages.system(mainSession, projectRun, `MERGE_CONFLICT: ${finalized.message}`, "recovery");
          if (!isMain) this.returnResult(projectRun, mainSession, currentTask, finalized.message);
          return;
        }
        currentTask = this.updateTask(mainSession, currentTask, "merge_ready", finalized.task);
      }
      currentTask = this.updateTask(mainSession, currentTask, "completed", { completedByMemberId: assigned.member.id });
      if (!isMain) this.returnResult(projectRun, mainSession, currentTask, completion.finalMessage ?? "Task completed.");
      return;
    }

    currentTask = this.updateTask(mainSession, currentTask, "failed");
    const failure = completion.run.failureCode ?? completion.finalMessage ?? `Run ended with ${completion.run.status}`;
    if (!isMain) this.returnResult(projectRun, mainSession, currentTask, failure);
  }

  private async continueAfterDelegation(projectRunId: string, receipts: DelegationReceipt[]): Promise<void> {
    const projectRun = this.requireProjectRun(projectRunId);
    const team = this.requireTeam(String(projectRun.teamId));
    const main = this.members.sessionMain(team, projectRun.mainAgentInstanceId);
    const mainSession = this.requireMainSession(projectRun);
    const handle = await this.runs.launch(
      mainSession,
      main.agent,
      this.prompts.delegationAccepted(projectRun.goal, receipts),
      { projectRunId, memberId: main.member.id, workingDirectory: this.workingDirectory(projectRun) }
    );
    const completion = await handle.completion;
    this.assertCompleted(completion, "delegation acknowledgement");
  }

  private returnResult(projectRun: ProjectRun, mainSession: Session, task: Task, result: string): void {
    this.messages.result(mainSession, projectRun, task, result);
    this.events.appendForSession(mainSession, { projectRunId: projectRun.id, taskId: task.id }, "handoff.created", {
      fromMemberId: String(task.assignedMemberId),
      toMemberId: projectRun.mainMemberId,
      summary: result.slice(0, 500),
      artifactIds: [],
      taskId: task.id,
      targetSessionId: mainSession.id
    });
  }

  private async finishRun(projectRunId: string, mainSession: Session): Promise<void> {
    let projectRun = this.requireProjectRun(projectRunId);
    if (!this.gitWorkflows) {
      this.saveProjectRun({ ...projectRun, status: "completed" });
      return;
    }
    projectRun = this.saveProjectRun({ ...projectRun, status: "verifying" });
    const finalized = await this.gitWorkflows.finalizeRun(projectRun, mainSession);
    if (!finalized.needsMergeApproval) {
      this.saveProjectRun({ ...finalized.projectRun, status: "completed" });
      return;
    }
    const approvalId = randomUUID();
    this.approvals?.request({ id: approvalId, category: "merge", operation: "git.merge.final", summary: `Merge ${finalized.projectRun.branchName} into ${finalized.projectRun.baseBranch}`, projectId: finalized.projectRun.projectId, projectRunId, sessionId: mainSession.id, requestedBy: finalized.projectRun.mainMemberId });
    const mergeReady = this.saveProjectRun({ ...finalized.projectRun, status: "merge_ready", mergeApprovalId: approvalId });
    this.events.appendForSession(mainSession, { projectRunId }, "approval.requested", {
      approvalId,
      category: "merge",
      summary: `Merge ${mergeReady.branchName} into ${mergeReady.baseBranch}. AgentHub will not push.`
    });
    this.events.appendForSession(mainSession, { projectRunId }, "run.waiting", { reason: "approval" });
  }

  private workingDirectory(projectRun: ProjectRun, task?: Task): string | undefined {
    return this.gitWorkflows?.workingDirectory(projectRun, task);
  }

  private updateTask(mainSession: Session, task: Task, status: Task["status"], patch: Partial<Task> = {}): Task {
    const updated = this.graph.saveStatus(task, status, patch);
    this.emitTask(mainSession, updated);
    return updated;
  }

  private emitTask(mainSession: Session, task: Task): void {
    this.events.appendForSession(mainSession, { projectRunId: task.projectRunId, taskId: task.id }, "task.updated", {
      taskId: task.id,
      status: task.status,
      assignedMemberId: task.assignedMemberId
    });
  }

  private assertCompleted(completion: RunCompletion, operation: string): void {
    if (completion.run.status !== "completed") {
      throw new CoreError("RUN_START_FAILED", { operation, runId: completion.run.id, status: completion.run.status, failureCode: completion.run.failureCode });
    }
  }

  private schedule(projectRunId: string, operation: () => Promise<void>): void {
    const execution = operation()
      .catch((error) => this.failProjectRun(projectRunId, error))
      .finally(() => this.active.delete(projectRunId));
    this.active.set(projectRunId, execution);
  }

  private failProjectRun(projectRunId: string, error: unknown): void {
    const projectRun = this.database.projectRuns.get(projectRunId);
    if (!projectRun) return;
    if (projectRun.status === "cancelled") return;
    const failed = this.saveProjectRun({ ...projectRun, status: "failed" });
    const mainSession = failed.mainSessionId ? this.database.sessions.get(failed.mainSessionId) : undefined;
    if (mainSession) {
      const descriptor = toAgentHubError(error);
      this.messages.system(mainSession, failed, `${descriptor.code}: ${descriptor.message}`, "recovery");
    }
  }

  private saveProjectRun(projectRun: ProjectRun): ProjectRun {
    const current = this.database.projectRuns.get(projectRun.id);
    if (current && current.status !== projectRun.status && !canTransitionProjectRun(current.status, projectRun.status)) {
      throw new Error(`Invalid project run transition ${current.status} -> ${projectRun.status} for ${projectRun.id}`);
    }
    const updated = { ...projectRun, updatedAt: new Date().toISOString() };
    this.database.projectRuns.save(updated);
    return updated;
  }

  private requireProjectRun(projectRunId: string): ProjectRun {
    const projectRun = this.database.projectRuns.get(projectRunId);
    if (!projectRun) throw new CoreError("IPC_NOT_FOUND", { resource: "projectRun", id: projectRunId });
    return projectRun;
  }

  private requireTeam(teamId: string): TeamDefinition {
    const team = this.database.teams.get(teamId);
    if (!team) throw new CoreError("IPC_NOT_FOUND", { resource: "team", id: teamId });
    return team;
  }

  private requireMainSession(projectRun: ProjectRun): Session {
    const session = projectRun.mainSessionId ? this.database.sessions.get(projectRun.mainSessionId) : undefined;
    if (!session) throw new CoreError("IPC_NOT_FOUND", { resource: "mainSession", projectRunId: projectRun.id });
    return session;
  }
}
