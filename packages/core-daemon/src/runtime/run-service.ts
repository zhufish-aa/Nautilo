import { randomUUID } from "node:crypto";
import type {
  AgentInstance,
  AgentRun,
  GitChangedFile,
  Message,
  ProjectRunId,
  Session,
  TaskId
} from "@agenthub/domain";
import { AdapterRegistry, type AdapterEvent, type AdapterFileDiff, type AdapterInteractionInput, type AdapterMcpServer } from "../adapters/index.js";
import { Database } from "../database/index.js";
import { EventService } from "./event-service.js";
import { ApprovalService, CommandPolicyService, CredentialService, EnvironmentPolicyService, RedactionService, providerEnvironmentPassthrough } from "./security/index.js";
import { CoreError } from "../errors.js";
import { AuditService } from "./observability/audit-service.js";
import { ArtifactService } from "./artifact-service.js";
import { SessionRunQueue } from "./session-run-queue.js";
import { RunDiffCollector } from "./run-diff-collector.js";
import { subagentMeta } from "./subagent-detection.js";
import { captureWorkspaceSnapshot, type WorkspaceSnapshot } from "./run-workspace-snapshot.js";
import { RUNTIME_TOOL_SCHEMA_VERSION, type RuntimeToolProvider } from "./runtime-tool-provider.js";
import { capabilityToMcpServer } from "../application/capability-service.js";
import type { InteractionService } from "../application/interaction-service.js";

export interface RunContext {
  projectRunId?: ProjectRunId;
  taskId?: TaskId;
  memberId?: string;
  messageKind?: Message["kind"];
  workingDirectory?: string;
  localImagePaths?: string[];
  synchronizeProviderContext?: boolean;
  /** Provider control commands run through the native transport without appearing as chat. */
  presentation?: "chat" | "provider_command";
  /** Provider-native control command forwarded to the adapter (e.g. Codex thread compaction). */
  providerCommand?: "compact";
  /** Internal marker persisted after a provider thread is created with runtime tools. */
  runtimeToolVersion?: number;
  /** Instance-configured context window; wins over provider-reported values in usage events. */
  contextWindowOverride?: number;
  /** Key marking this turn as withdrawable while it waits in the per-session queue. */
  queueKey?: string;
}

export interface RunCompletion {
  run: AgentRun;
  messages: Message[];
  finalMessage?: string;
}

export interface RunHandle {
  runId: string;
  completion: Promise<RunCompletion>;
}

interface ActiveRun {
  sessionId: string;
  cancel: () => Promise<void>;
  steer?: (input: string) => Promise<void>;
  completion: Promise<RunCompletion>;
  projectRunId?: ProjectRunId;
}

export class RunService {
  private readonly active = new Map<string, ActiveRun>();
  private readonly outputTails = new Map<string, string>();
  private readonly messageBuffers = new Map<string, Map<string, string>>();
  private readonly artifactService: ArtifactService;
  private readonly diffCollector = new RunDiffCollector();
  private readonly touchedFiles = new Map<string, Map<string, { path: string; changeType: GitChangedFile["changeType"] }>>();
  private readonly workspaceBaselines = new Map<string, WorkspaceSnapshot>();
  private readonly sessionQueue = new SessionRunQueue();
  private runtimeToolProvider?: RuntimeToolProvider;
  private interactions?: InteractionService;

  constructor(
    private readonly database: Database,
    private readonly adapters: AdapterRegistry,
    private readonly events: EventService,
    private readonly credentials?: CredentialService,
    private readonly environment = new EnvironmentPolicyService(),
    private readonly commandPolicies?: CommandPolicyService,
    private readonly approvals?: ApprovalService,
    private readonly redaction = new RedactionService(),
    private readonly audit?: AuditService
  ) {
    this.artifactService = new ArtifactService(database);
  }

  setRuntimeToolProvider(provider: RuntimeToolProvider): void {
    this.runtimeToolProvider = provider;
  }

  setInteractionService(interactions: InteractionService): void {
    this.interactions = interactions;
  }

  async cancel(runId: string): Promise<void> {
    const active = this.active.get(runId);
    const existing = this.database.runs.get(runId);
    if (!active) {
      if (existing && !["completed", "failed", "timed_out", "crashed", "cancelled"].includes(existing.status)) {
        this.database.runs.save({ ...existing, status: "cancelled", endedAt: new Date().toISOString(), failureCode: "RUN_CANCELLED" });
        this.updateSessionStatus(existing.sessionId, "idle");
      }
      return;
    }
    if (existing) this.database.runs.save({ ...existing, status: "cancelling" });
    await active.cancel();
    const latest = this.database.runs.get(runId) ?? existing;
    if (latest) {
      this.database.runs.save({ ...latest, status: "cancelled", endedAt: new Date().toISOString(), failureCode: "RUN_CANCELLED" });
      this.updateSessionStatus(latest.sessionId, "idle");
      this.audit?.record({ actorType: "system", actorId: "core-daemon", action: "run.cancelled", resourceType: "run", resourceId: runId, outcome: "success" });
    }
  }

  async cancelProjectRun(projectRunId: ProjectRunId): Promise<void> {
    const runIds = [...this.active.entries()]
      .filter(([, active]) => active.projectRunId === projectRunId)
      .map(([runId]) => runId);
    await Promise.all(runIds.map((runId) => this.cancel(runId)));
  }

  /** True when the session's in-flight turn can accept immediate guidance. */
  canSteer(sessionId: string): boolean {
    const active = [...this.active.values()].find((run) => run.sessionId === sessionId);
    return typeof active?.steer === "function";
  }

  /** Sends new user guidance into an in-flight provider turn without cancelling it. */
  async steerSession(sessionId: string, input: string): Promise<void> {
    const active = [...this.active.values()].find((run) => run.sessionId === sessionId);
    if (!active) throw new CoreError("IPC_INVALID_REQUEST", { field: "sessionId", reason: "There is no active run to guide." });
    if (!active.steer) throw new CoreError("IPC_INVALID_REQUEST", { field: "sessionId", reason: "The active provider does not support immediate guidance. Use Queue instead." });
    await active.steer(input);
  }

  async start(
    session: Session,
    agent: AgentInstance,
    prompt: string,
    context: RunContext = {}
  ): Promise<string> {
    return (await this.launch(session, agent, prompt, context)).runId;
  }

  async launch(
    session: Session,
    agent: AgentInstance,
    prompt: string,
    context: RunContext = {}
  ): Promise<RunHandle> {
    return this.sessionQueue.enqueue(session.id, () => this.launchNow(session, agent, prompt, context), context.queueKey);
  }

  /** Withdraws a queued (not yet started) turn by its queue key. */
  cancelQueued(sessionId: string, key: string): boolean {
    return this.sessionQueue.cancelPending(sessionId, key);
  }

  private async launchNow(
    session: Session,
    agent: AgentInstance,
    prompt: string,
    context: RunContext
  ): Promise<RunHandle> {
    // An explicit per-model context window from the instance editor always wins;
    // live discovery (kimi/claude) only runs when nothing is configured.
    const configuredContextWindow = agent.models?.find((entry) => entry.id === session.model)?.contextWindow
      ?? (!session.model && agent.models?.length === 1 ? agent.models[0].contextWindow : undefined);
    let contextWindow: number | undefined = configuredContextWindow;
    if (!contextWindow && this.adapters.find(agent.providerId)?.descriptor?.contextWindowDiscovery) {
      const catalog = await this.adapters.listModels(agent).catch(() => undefined);
      const modelId = session.model || catalog?.defaultModel;
      const discoveredContextWindow = catalog?.models.find((model) => model.id === modelId)?.contextWindow;
      if (discoveredContextWindow) contextWindow = discoveredContextWindow;
    }
    const project = this.database.projects.get(session.projectId);
    const policy = this.commandPolicies?.get(project?.policyId ?? "default");
    const commandEvaluation = this.commandPolicies?.evaluate({ policyId: policy?.id, command: agent.executable, args: agent.baseArgs, source: "agent" });
    if (commandEvaluation?.action === "blocked") {
      this.audit?.record({ actorType: "agent", actorId: context.memberId ?? session.memberId, action: "command.blocked", resourceType: "agentInstance", resourceId: agent.id, outcome: "denied", details: { command: agent.executable, ruleId: commandEvaluation.ruleId } });
      throw new CoreError("COMMAND_BLOCKED", { command: agent.executable, ruleId: commandEvaluation.ruleId });
    }
    if (
      commandEvaluation?.action === "approval" &&
      !this.approvals?.authorize(`agent.launch:${agent.id}`, { projectId: project?.id, projectRunId: context.projectRunId, taskId: context.taskId })
    ) {
      const approval = this.approvals?.request({
        category: "command",
        operation: `agent.launch:${agent.id}`,
        summary: `Launch ${agent.displayName}`,
        projectId: project?.id,
        projectRunId: context.projectRunId,
        taskId: context.taskId,
        sessionId: session.id,
        requestedBy: context.memberId ?? session.memberId
      });
      this.database.sessions.save({ ...session, status: "waiting_approval", updatedAt: new Date().toISOString() });
      if (approval) {
        this.events.appendForSession(session, { projectRunId: context.projectRunId, taskId: context.taskId }, "approval.requested", {
          approvalId: approval.id,
          category: "command",
          summary: approval.summary
        });
        this.audit?.record({ actorType: "agent", actorId: context.memberId ?? session.memberId, action: "command.approval_requested", resourceType: "approval", resourceId: approval.id, outcome: "success", details: { agentInstanceId: agent.id, operation: approval.operation } });
      }
      throw new CoreError("COMMAND_APPROVAL_REQUIRED", { approvalId: approval?.id });
    }

    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const run: AgentRun = {
      id: runId,
      projectRunId: context.projectRunId,
      taskId: context.taskId,
      sessionId: session.id,
      agentInstanceId: agent.id,
      memberId: context.memberId ?? session.memberId,
      mode: "headless_structured",
      status: "starting",
      startedAt
    };
    this.database.runs.save(run);
    this.audit?.record({ actorType: "agent", actorId: context.memberId ?? session.memberId, action: "run.started", resourceType: "run", resourceId: run.id, outcome: "success", details: { agentInstanceId: agent.id, sessionId: session.id, projectRunId: context.projectRunId, taskId: context.taskId } });
    this.database.sessions.save({ ...session, status: "running", updatedAt: startedAt });
    if (context.presentation !== "provider_command") this.events.append(session, run, "run.started", { runId });

    const additions = {
      ...providerEnvironmentPassthrough(agent, process.env, this.adapters.find(agent.providerId)?.descriptor),
      ...this.credentials?.environment(agent.id, agent.providerId)
    };
    const runtimeToolBinding = context.presentation === "provider_command"
      ? undefined
      : this.runtimeToolProvider?.forRun(session, context);
    const request = {
      instance: agent,
      prompt,
      cwd: context.workingDirectory ?? project?.rootPath ?? process.cwd(),
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      serviceTier: session.serviceTier,
      permissionMode: session.permissionMode,
      contextWindow,
      env: this.environment.build(policy, additions),
      timeoutMs: 30 * 60_000,
      idleTimeoutMs: 30 * 60_000,
      localImagePaths: context.localImagePaths,
      providerCommand: context.providerCommand,
      mcpServers: this.resolveMcpServers(agent),
      ...(runtimeToolBinding ? { runtimeTools: runtimeToolBinding.tools, executeRuntimeTool: runtimeToolBinding.execute } : {}),
      ...(this.interactions && context.presentation !== "provider_command"
        ? { requestInteraction: (input: AdapterInteractionInput) => this.interactions!.request(session, runId, agent.providerId, input) }
        : {})
    };

    try {
      if (context.presentation !== "provider_command") {
        const isGitWorkspace = await this.diffCollector.isGitWorkspace(request.cwd).catch(() => false);
        if (!isGitWorkspace) {
          const snapshot = await captureWorkspaceSnapshot(request.cwd).catch(() => undefined);
          if (snapshot) this.workspaceBaselines.set(runId, snapshot);
        }
      }
      const currentSession = this.database.sessions.get(session.id) ?? session;
      const mustRecreateCodexThread = agent.providerId === "codex"
        && Boolean(runtimeToolBinding)
        && currentSession.runtimeToolVersion !== RUNTIME_TOOL_SCHEMA_VERSION;
      const adapterRun = currentSession.providerSessionId && this.adapters.capabilities(agent).nativeResume && !mustRecreateCodexThread
        ? this.adapters.resume({ ...request, providerSessionId: currentSession.providerSessionId })
        : this.adapters.start(request);
      const completion = this.consume(run, currentSession, adapterRun.events, {
        ...context,
        runtimeToolVersion: runtimeToolBinding ? RUNTIME_TOOL_SCHEMA_VERSION : context.runtimeToolVersion,
        contextWindowOverride: configuredContextWindow ?? context.contextWindowOverride
      });
      this.active.set(runId, { sessionId: session.id, cancel: adapterRun.cancel, steer: adapterRun.steer, completion, projectRunId: context.projectRunId });
      void completion.finally(() => {
        this.active.delete(runId);
        this.interactions?.cancelForRun(runId);
      });
      return { runId, completion };
    } catch (error) {
      this.workspaceBaselines.delete(runId);
      const failed = this.failRun(run, session, error, context.presentation === "provider_command");
      return { runId, completion: Promise.resolve({ run: failed, messages: [] }) };
    }
  }

  /** User-managed MCP servers enabled for this run's provider, with env passthrough resolved. */
  private resolveMcpServers(agent: AgentInstance): AdapterMcpServer[] {
    return this.database.capabilities.list()
      .filter((capability) => capability.enabled && capability.providerIds.includes(agent.providerId))
      .map((capability) => capabilityToMcpServer(capability))
      .filter((server): server is AdapterMcpServer => server !== undefined);
  }

  private async consume(
    run: AgentRun,
    session: Session,
    adapterEvents: AsyncIterable<AdapterEvent>,
    context: RunContext
  ): Promise<RunCompletion> {
    const messages: Message[] = [];
    try {
      for await (const event of adapterEvents) {
        const message = await this.persist(run, session, event, context);
        if (message) messages.push(message);
      }
      if (context.presentation !== "provider_command") await this.collectRunDiff(run, session, context);
      const latest = this.database.runs.get(run.id) ?? run;
      const failedStatuses: AgentRun["status"][] = ["failed", "timed_out", "cancelled", "cancelling", "crashed"];
      if (failedStatuses.includes(latest.status)) {
        const cancelled = latest.status === "cancelled" || latest.status === "cancelling";
        const detail = cancelled
          ? "CLI process cancelled"
          : this.outputTails.get(run.id)?.trim() || (latest.status === "timed_out" ? "CLI process timed out" : "CLI process failed");
        if (context.presentation !== "provider_command") {
          this.events.append(session, latest, "run.failed", {
            code: latest.failureCode ?? "RUN_START_FAILED",
            message: detail.slice(-4_000),
            retryable: !cancelled
          });
        }
        this.updateSessionStatus(session.id, context.presentation === "provider_command" || cancelled ? "idle" : "failed");
        this.outputTails.delete(run.id);
        this.touchedFiles.delete(run.id);
        this.workspaceBaselines.delete(run.id);
        return { run: latest, messages, finalMessage: messages.at(-1)?.text };
      }

      const completed: AgentRun = { ...latest, status: "completed", endedAt: latest.endedAt ?? new Date().toISOString() };
      this.database.runs.save(completed);
      this.audit?.record({ actorType: "agent", actorId: run.memberId ?? session.memberId, action: "run.completed", resourceType: "run", resourceId: run.id, outcome: "success", details: { exitCode: completed.exitCode } });
      if (context.presentation !== "provider_command") {
        this.events.append(session, completed, "run.completed", { summary: messages.at(-1)?.text ?? "CLI process completed" });
      }
      this.updateSessionStatus(session.id, context.presentation === "provider_command" ? "idle" : "completed");
      this.outputTails.delete(run.id);
      this.touchedFiles.delete(run.id);
      this.workspaceBaselines.delete(run.id);
      return { run: completed, messages, finalMessage: messages.at(-1)?.text };
    } catch (error) {
      const failed = this.failRun(run, session, error, context.presentation === "provider_command");
      this.outputTails.delete(run.id);
      this.touchedFiles.delete(run.id);
      this.workspaceBaselines.delete(run.id);
      return { run: failed, messages, finalMessage: messages.at(-1)?.text };
    }
  }

  private failRun(run: AgentRun, session: Session, error: unknown, providerCommand = false): AgentRun {
    const failed: AgentRun = {
      ...(this.database.runs.get(run.id) ?? run),
      status: "failed",
      endedAt: new Date().toISOString(),
      failureCode: "RUN_START_FAILED"
    };
    this.database.runs.save(failed);
    this.audit?.record({ actorType: "agent", actorId: run.memberId ?? session.memberId, action: "run.failed", resourceType: "run", resourceId: run.id, outcome: "failure", details: { failureCode: failed.failureCode, error: error instanceof Error ? error.message : String(error) } });
    if (!providerCommand) {
      this.events.append(session, failed, "run.failed", {
        code: "RUN_START_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: true
      });
    }
    this.updateSessionStatus(session.id, providerCommand ? "idle" : "failed");
    return failed;
  }

  private updateSessionStatus(sessionId: string, status: Session["status"]): void {
    const current = this.database.sessions.get(sessionId);
    if (current) this.database.sessions.save({ ...current, status, updatedAt: new Date().toISOString() });
  }

  private async persist(
    run: AgentRun,
    session: Session,
    event: AdapterEvent,
    context: RunContext
  ): Promise<Message | undefined> {
    if (event.kind === "message") {
      const messageId = event.messageId ?? "default";
      // Sub-agent messages share the run with the main agent; keep their delta
      // buffers separate and never persist them as chat history, otherwise they
      // would leak into the provider context replayed on the next turn.
      const bufferKey = event.subagentDispatchId ? `sub:${event.subagentDispatchId}:${messageId}` : messageId;
      if (event.phase === "delta") {
        const buffers = this.messageBuffers.get(run.id) ?? new Map<string, string>();
        buffers.set(bufferKey, `${buffers.get(bufferKey) ?? ""}${event.text}`);
        this.messageBuffers.set(run.id, buffers);
        if (context.presentation !== "provider_command") {
          this.events.append(session, run, "agent.message_delta", { messageId: bufferKey, text: this.redaction.text(event.text), subagentDispatchId: event.subagentDispatchId });
        }
        return undefined;
      }
      const buffered = this.messageBuffers.get(run.id)?.get(bufferKey);
      const finalText = event.text || buffered || "";
      this.messageBuffers.get(run.id)?.delete(bufferKey);
      if (!finalText) return undefined;
      const message: Message = {
        id: randomUUID(),
        sessionId: session.id,
        sender: "agent",
        kind: context.messageKind ?? "chat",
        projectRunId: context.projectRunId,
        taskId: context.taskId,
        runId: run.id,
        fromMemberId: context.memberId ?? session.memberId,
        text: this.redaction.text(finalText),
        createdAt: new Date().toISOString()
      };
      if (context.presentation !== "provider_command") {
        if (!event.subagentDispatchId) this.database.sessions.saveMessage(message);
        this.events.append(session, run, "agent.message", { messageId: message.id, text: message.text, subagentDispatchId: event.subagentDispatchId });
      }
      return message;
    }
    if (event.kind === "thinking" && event.phase === "delta") {
      if (context.presentation !== "provider_command") this.events.append(session, run, "agent.thinking_delta", { messageId: event.messageId ?? "default", text: this.redaction.text(event.text), subagentDispatchId: event.subagentDispatchId });
    }
    else if (event.kind === "thinking") {
      if (context.presentation !== "provider_command") this.events.append(session, run, "agent.thinking_summary", { messageId: event.messageId, text: this.redaction.text(event.text), subagentDispatchId: event.subagentDispatchId });
    }
    else if (event.kind === "status") {
      if (context.presentation !== "provider_command") this.events.append(session, run, "agent.status", { phase: event.phase });
    }
    else if (event.kind === "session") {
      const current = this.database.sessions.get(session.id) ?? session;
      const now = new Date().toISOString();
      this.database.sessions.save({
        ...current,
        providerSessionId: event.providerSessionId,
        providerContextSyncedAt: now,
        runtimeToolVersion: context.runtimeToolVersion ?? current.runtimeToolVersion,
        updatedAt: now
      });
    } else if (event.kind === "usage") this.events.append(session, run, "usage.updated", {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      contextUsed: event.contextUsed,
      contextWindow: context.contextWindowOverride ?? event.contextWindow
    });
    else if (event.kind === "commands") this.events.append(session, run, "provider.commands_updated", {
      providerId: this.database.agents.get(session.agentInstanceId ?? "")?.providerId ?? "unknown",
      commands: event.commands
    });
    else if (event.kind === "artifact") {
      const content = event.data ?? "";
      const metadata = event.mimeType ? { mimeType: event.mimeType } : undefined;
      const artifact = event.path ? await this.artifactService.saveFileReference({
        kind: event.artifactType,
        name: event.name,
        path: event.path,
        projectRunId: context.projectRunId,
        taskId: context.taskId,
        sessionId: session.id,
        metadata
      }) : this.artifactService.save({
        kind: event.artifactType,
        name: event.name,
        content,
        projectRunId: context.projectRunId,
        taskId: context.taskId,
        sessionId: session.id,
        metadata
      });
      this.events.append(session, run, "artifact.created", {
        artifactId: artifact.id,
        kind: event.artifactType,
        name: event.name,
        mimeType: event.mimeType,
        path: event.path
      });
    }
    else if (event.kind === "tool" && event.phase === "completed") this.events.append(session, run, "tool.finished", {
      callId: event.callId,
      toolName: event.name,
      success: event.success ?? true,
      inputSummary: this.eventDetail(event.input, this.toolInputLimit(event.name)),
      outputSummary: this.eventDetail(event.output, 2_000),
      fileDiff: this.eventFileDiff(event.fileDiff),
      subagent: subagentMeta(event.name, event.input),
      subagentDispatchId: event.subagentDispatchId
    });
    else if (event.kind === "tool") this.events.append(session, run, "tool.started", {
      callId: event.callId,
      toolName: event.name,
      inputSummary: this.eventDetail(event.input, this.toolInputLimit(event.name)),
      fileDiff: this.eventFileDiff(event.fileDiff),
      subagent: subagentMeta(event.name, event.input),
      subagentDispatchId: event.subagentDispatchId
    });
    else if (event.kind === "command" && event.phase === "completed") this.events.append(session, run, "command.finished", {
      callId: event.callId,
      command: event.command,
      exitCode: event.exitCode ?? 0,
      durationMs: 0,
      outputSummary: event.output ? this.redaction.text(event.output.slice(0, 2_000)) : undefined,
      subagentDispatchId: event.subagentDispatchId
    });
    else if (event.kind === "command") this.events.append(session, run, "command.started", { callId: event.callId, command: event.command, cwd: context.workingDirectory ?? this.database.projects.get(session.projectId)?.rootPath ?? process.cwd(), subagentDispatchId: event.subagentDispatchId });
    else if (event.kind === "file") {
      const changeType = normalizeChangeType(event.changeType);
      const touched = this.touchedFiles.get(run.id) ?? new Map();
      touched.set(event.path, { path: event.path, changeType });
      this.touchedFiles.set(run.id, touched);
      // Providers (e.g. Codex file_change) often ship only the unified patch,
      // so derive the +/- counts from it when explicit numbers are missing.
      const derived = diffLineCounts(event.diff);
      this.events.append(session, run, "file.changed", {
        path: event.path,
        changeType,
        additions: event.additions ?? derived.additions,
        deletions: event.deletions ?? derived.deletions,
        diff: event.diff ? this.redaction.text(event.diff) : undefined
      });
    }
    else if (event.kind === "exit") {
      const current = this.database.runs.get(run.id) ?? run;
      if (!["cancelled", "cancelling"].includes(current.status)) {
        this.database.runs.save({ ...current, status: event.exitCode === 0 ? "completed" : "failed", endedAt: new Date().toISOString(), exitCode: event.exitCode ?? undefined });
      }
    } else if (event.kind === "timeout") this.database.runs.save({ ...(this.database.runs.get(run.id) ?? run), status: "timed_out", endedAt: new Date().toISOString(), failureCode: `RUN_${event.reason.toUpperCase()}` });
    else if (event.kind === "error") {
      this.rememberOutput(run.id, event.error.message);
      this.database.runs.save({ ...(this.database.runs.get(run.id) ?? run), status: "failed", endedAt: new Date().toISOString(), failureCode: "PROVIDER_ERROR" });
    } else if (event.kind === "raw") this.rememberOutput(run.id, event.text);
    return undefined;
  }

  private rememberOutput(runId: string, text: string): void {
    const redacted = this.redaction.text(text);
    this.outputTails.set(runId, `${this.outputTails.get(runId) ?? ""}${redacted}`.slice(-8_192));
  }

  /**
   * Todo-tracking tools (Kimi TodoList, Claude TodoWrite, Codex update_plan)
   * carry the whole task list in their input; the desktop goal card needs the
   * full JSON, so those inputs get a larger summary budget than other tools.
   */
  private toolInputLimit(toolName: string): number {
    const normalized = toolName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    return ["todolist", "todo_list", "todowrite", "todo_write", "update_plan"].includes(normalized) ? 16_000 : 2_000;
  }

  private eventDetail(value: unknown, limit: number): string | undefined {
    if (value === undefined || value === null) return undefined;
    let detail: string;
    if (typeof value === "string") detail = value.trim();
    else {
      try { detail = JSON.stringify(value, null, 2); }
      catch { detail = String(value); }
    }
    if (!detail || detail === '""') return undefined;
    return this.redaction.text(detail.slice(0, limit));
  }

  private eventFileDiff(value: AdapterFileDiff | undefined): AdapterFileDiff & { truncated?: boolean } | undefined {
    if (!value) return undefined;
    const limit = 20_000;
    const truncated = value.before.length > limit || value.after.length > limit;
    return {
      operation: value.operation,
      path: value.path,
      before: value.before.slice(0, limit),
      after: value.after.slice(0, limit),
      truncated: truncated || undefined
    };
  }

  private async collectRunDiff(run: AgentRun, session: Session, context: RunContext): Promise<void> {
    const touched = [...(this.touchedFiles.get(run.id)?.values() ?? [])];
    if (!touched.length) return;
    const project = this.database.projects.get(session.projectId);
    const cwd = context.workingDirectory ?? project?.rootPath;
    if (!cwd) return;
    const files = await this.diffCollector.collect(cwd, touched, this.workspaceBaselines.get(run.id)).catch(() => []);
    if (!files.length) return;
    const artifact = this.artifactService.save({
      kind: "diff",
      name: `${session.title.slice(0, 80) || "run"}.diff.json`,
      content: JSON.stringify({ files }),
      projectRunId: context.projectRunId,
      taskId: context.taskId,
      sessionId: session.id,
      metadata: { runId: run.id, paths: files.map((file) => file.path), fileCount: files.length }
    });
    this.events.append(session, run, "git.diff_collected", {
      artifactId: artifact.id,
      taskId: context.taskId,
      fileCount: files.length
    });
  }
}

function diffLineCounts(diff?: string): { additions?: number; deletions?: number } {
  if (!diff) return {};
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function normalizeChangeType(value?: string): GitChangedFile["changeType"] {
  if (value === "added" || value === "deleted" || value === "renamed" || value === "modified") return value;
  if (value === "add" || value === "create") return "added";
  if (value === "delete" || value === "remove") return "deleted";
  if (value === "rename") return "renamed";
  return "modified";
}
