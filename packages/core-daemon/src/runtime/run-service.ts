import { applyConnection, boundConnection, connectionEnvironment } from "./runtime-connection.js";
import { imageGenerationExecutor } from "./image-generation.js";
import { generateSessionTitle } from "./session-title.js";
import { randomUUID } from "node:crypto";
import { RequestLogService } from "./request-log.js";
import { checkNativeAccountLogin, isAccountAuthenticationError } from "./account-auth.js";
import { startApiStreamObserver } from "../adapters/api-stream-observer.js";
import { startChatCompatProxy } from "../adapters/codex/chat-compat-proxy.js";
import { startAnthropicCompatProxy } from "../adapters/codex/anthropic-compat-proxy.js";
import { startClaudeApiProxy } from "../adapters/claude/api-proxy.js";
import type {
  AgentInstance,
  AgentRun,
  GitChangedFile,
  Message,
  ProjectRunId,
  Session,
  TaskId
} from "@agenthub/domain";
import { AdapterRegistry, type AdapterEvent, type AdapterFileDiff, type AdapterInteractionInput, type AdapterMcpServer, type AdapterSkill } from "../adapters/index.js";
import { configuredModelReasoningEffort } from "../adapters/model-config.js";
import { Database } from "../database/index.js";
import { EventService } from "./event-service.js";
import { ApprovalService, CommandPolicyService, CredentialService, EnvironmentPolicyService, RedactionService, providerEnvironmentPassthrough, isolateLoginProfile } from "./security/index.js";
import { CoreError } from "../errors.js";
import { AuditService } from "./observability/audit-service.js";
import { ArtifactService } from "./artifact-service.js";
import { SessionRunQueue } from "./session-run-queue.js";
import { RunDiffCollector } from "./run-diff-collector.js";
import { subagentMeta } from "./subagent-detection.js";
import { captureWorkspaceSnapshot, type WorkspaceSnapshot } from "./run-workspace-snapshot.js";
import { RUNTIME_TOOL_SCHEMA_VERSION, type RuntimeToolProvider } from "./runtime-tool-provider.js";
import { capabilityToMcpServer } from "../application/capability-service.js";
import { AccountGateways } from "./account-gateway.js";
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
  providerCommand?: string;
  /** Internal marker persisted after a provider thread is created with runtime tools. */
  runtimeToolVersion?: number;
  /** Instance-configured context window; wins over provider-reported values in usage events. */
  contextWindowOverride?: number;
  /** Key marking this turn as withdrawable while it waits in the per-session queue. */
  queueKey?: string;
  requestId?: string;
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
  readonly requestLogs: RequestLogService;
  private readonly accountGateways?: AccountGateways;
  generateSessionTitle(sessionId: string): Promise<{ title?: string }> {
    return this.credentials ? generateSessionTitle(this.database, this.credentials, sessionId) : Promise.resolve({});
  }
  private stopping = false;
  private stopPromise?: Promise<void>;
  private readonly launching = new Set<Promise<RunHandle>>();

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    const active = [...this.active.entries()];
    this.stopPromise = (async () => {
      for (const [id] of active) this.interactions?.cancelForRun(id);
      await Promise.allSettled(active.map(([id]) => this.cancel(id)));
      await Promise.allSettled(active.map(([, run]) => run.completion));
      await Promise.allSettled([...this.launching]);
    })();
    return this.stopPromise;
  }

  private assertRunning(): void {
    if (this.stopping) throw new Error("RunService is stopping; new runs are disabled");
  }

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
    this.requestLogs = new RequestLogService(database, redaction);
    if(credentials)this.accountGateways=new AccountGateways(database,adapters,credentials);
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
    if(existing)await this.accountGateways?.cancelSession(existing.sessionId);
    if (!active) {
      if (existing && !["completed", "failed", "timed_out", "crashed", "cancelled"].includes(existing.status)) {
        const cancelled = { ...existing, status: "cancelled" as const, endedAt: new Date().toISOString(), failureCode: "RUN_CANCELLED" };
        this.database.runs.save(cancelled);
        const session = this.database.sessions.get(existing.sessionId);
        if (session) this.events.append(session, cancelled, "run.cancelled", { reason: "user" });
        this.updateSessionStatus(existing.sessionId, "idle");
      }
      return;
    }
    if (existing) this.database.runs.save({ ...existing, status: "cancelling" });
    this.interactions?.cancelForRun(runId);
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
    this.assertRunning();
    // Heal orphaned interaction requests before the run's events make the
    // renderer re-read the journal — a replayed request would otherwise
    // resurrect a card whose pending entry died with an older daemon.
    this.interactions?.healOrphaned(session.id);
    // Capture model preferences at submission, while retaining fresh native-thread
    // state and permission tightening when this queued request actually starts.
    const submitted = this.database.sessions.get(session.id);
    if (submitted) {
      if (submitted.projectId !== session.projectId || submitted.agentInstanceId !== session.agentInstanceId || submitted.connectionId !== session.connectionId || submitted.connectionRevision !== session.connectionRevision) {
        throw new CoreError("IPC_INVALID_REQUEST", { field: "sessionId", reason: "Conversation identity changed before admission; send again" });
      }
      session = { ...session, agentMode: submitted.agentMode, model: submitted.model, reasoningEffort: submitted.reasoningEffort, serviceTier: submitted.serviceTier };
    }

    const requestId = this.requestLogs.begin(session, agent, context.providerCommand ?? "message", context.queueKey);
    context = { ...context, requestId };
    const pending = this.sessionQueue.enqueue(session.id, async () => {
      this.requestLogs.mark(requestId,"preparing");
      try { return await this.launchNow(session, agent, prompt, context); }
      catch(error) { this.requestLogs.finish(requestId,"failed",error instanceof CoreError ? error.descriptor.code : "RUN_START_FAILED",error instanceof Error ? error.message : String(error)); throw error; }
    }, context.queueKey);
    this.launching.add(pending);
    void pending.then(() => this.launching.delete(pending), () => this.launching.delete(pending));
    return pending;
  }

  /** Withdraws a queued (not yet started) turn by its queue key. */
  cancelQueued(sessionId: string, key: string): boolean {
    const cancelled = this.sessionQueue.cancelPending(sessionId, key);
    if (cancelled) this.requestLogs.cancelQueued(sessionId,key);
    return cancelled;
  }

  steerQueued(sessionId: string, key: string, text: string): Promise<boolean> {
    return this.sessionQueue.promotePending(sessionId, key, () => this.steerSession(sessionId, text));
  }

  private async launchNow(
    session: Session,
    agent: AgentInstance,
    prompt: string,
    context: RunContext
  ): Promise<RunHandle> {
    this.assertRunning();
    // A queued turn may wait while its predecessor learns the native thread
    // id, context window, or newer session settings. Never write the snapshot
    // captured at enqueue time back over those persisted updates.
    const latestSession = this.database.sessions.get(session.id);
    if (latestSession) {
      if (latestSession.projectId !== session.projectId || latestSession.agentInstanceId !== session.agentInstanceId || latestSession.connectionId !== session.connectionId || latestSession.connectionRevision !== session.connectionRevision) {
        throw new CoreError("IPC_INVALID_REQUEST", { field: "sessionId", reason: "The session target changed while this turn was queued. Send the message again." });
      }
      session = { ...latestSession, agentMode: session.agentMode, model: session.model, reasoningEffort: session.reasoningEffort, serviceTier: session.serviceTier };
    }
    const selectedConnection = boundConnection(this.database, session);
    if (!selectedConnection && agent.providerOptions?.configurationKind === "harness") throw new CoreError("IPC_INVALID_REQUEST", { field: "connectionId", reason: "Select a provider or login account for this harness" });
    if (selectedConnection) {
      agent = applyConnection(selectedConnection, agent);
      connectionEnvironment(selectedConnection, agent, {}, this.credentials);
      if (selectedConnection.kind === "api" && !session.model) throw new CoreError("IPC_INVALID_REQUEST", { field: "model", reason: "Choose an explicit model for the selected API connection" });
    }
    const configuredModel = agent.models?.find((entry) => entry.id.trim() === session.model);
    if (configuredModel?.enabled === false) {
      throw new CoreError("IPC_INVALID_REQUEST", { field: "model", reason: "This model is disabled. Choose an enabled model." });
    }
    // The Messages bridge cannot translate reasoning effort. Do not turn an
    // old supported-efforts list into an implicit request; explicit choices
    // still reach the bridge guard and produce a clear unsupported error.
    const anthropicBridge = agent.providerId === "codex" && agent.providerOptions?.wireApi === "anthropic";
    const reasoningEffort = session.reasoningEffort?.trim() || (anthropicBridge
      ? configuredModel?.defaultReasoningEffort?.trim() || undefined
      : configuredModelReasoningEffort(configuredModel));
    // An explicit per-model context window from the instance editor always wins;
    // live discovery (kimi/claude) only runs when nothing is configured.
    const configuredContextWindow = agent.models?.find((entry) => entry.id === session.model)?.contextWindow
      ?? (!session.model && agent.models?.length === 1 ? agent.models[0].contextWindow : undefined);
    // A window previously reported by the provider itself wins over the
    // configured catalog entry — catalogs go stale (K3-256k catalogs 256k
    // while the provider actually runs 1M), and the kimi usage fallback
    // divides by this value.
    let contextWindow: number | undefined = session.providerContextWindow && session.providerContextWindow > 0
      ? session.providerContextWindow
      : configuredContextWindow;
    if (!contextWindow && !selectedConnection && this.adapters.find(agent.providerId)?.descriptor?.contextWindowDiscovery) {
      const catalog = await this.adapters.listModelsForRun(agent);
      const modelId = session.model || catalog?.defaultModel;
      const discoveredContextWindow = catalog?.models.find((model) => model.id === modelId)?.contextWindow;
      if (discoveredContextWindow) contextWindow = discoveredContextWindow;
    }
    this.assertRunning();
    const project = this.database.projects.get(session.projectId);
    const policy = this.commandPolicies?.get(project?.policyId ?? "default");
    const commandEvaluation = this.commandPolicies?.evaluate({ policyId: policy?.id, command: agent.executable, args: agent.baseArgs, source: "agent" });
    if (commandEvaluation?.action === "blocked") {
      this.audit?.record({ actorType: "agent", actorId: context.memberId ?? session.memberId, action: "command.blocked", resourceType: "agentInstance", resourceId: agent.id, outcome: "denied", details: { command: agent.executable, ruleId: commandEvaluation.ruleId } });
      throw new CoreError("COMMAND_BLOCKED", { command: agent.executable, ruleId: commandEvaluation.ruleId });
    }
    if (
      commandEvaluation?.action === "approval" &&
      !this.approvals?.authorize(`agent.launch:${agent.id}`, { projectId: project?.id, projectRunId: context.projectRunId, taskId: context.taskId, sessionId: session.id })
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
      this.database.sessions.save({ ...(this.database.sessions.get(session.id) ?? session), status: "waiting_approval", updatedAt: new Date().toISOString() });
      if (approval) {
        this.events.appendForSession(session, { projectRunId: context.projectRunId, taskId: context.taskId }, "approval.requested", {
          approvalId: approval.id,
          category: "command",
          summary: approval.summary,
          operation: approval.operation
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
      connectionId: selectedConnection?.id,
      connectionRevision: selectedConnection?.revision,
      model: session.model,
      pricingSnapshot: agent.models?.find((model) => model.id === session.model)?.pricing,
      memberId: context.memberId ?? session.memberId,
      mode: "headless_structured",
      status: "starting",
      startedAt
    };
    this.database.runs.save(run);
    this.requestLogs.attach(context.requestId,run.id);
    this.audit?.record({ actorType: "agent", actorId: context.memberId ?? session.memberId, action: "run.started", resourceType: "run", resourceId: run.id, outcome: "success", details: { agentInstanceId: agent.id, sessionId: session.id, projectRunId: context.projectRunId, taskId: context.taskId } });
    this.database.sessions.save({ ...(this.database.sessions.get(session.id) ?? session), status: "running", updatedAt: startedAt });
    if (context.presentation !== "provider_command") {
      const userMessageId = context.queueKey;
      this.events.append(session, run, "run.started", { runId, ...(userMessageId ? { userMessageId } : {}) });
    }

    const additions = {
      ...providerEnvironmentPassthrough(agent, process.env, this.adapters.find(agent.providerId)?.descriptor),
      ...(!selectedConnection ? this.credentials?.environment(agent.id, agent.providerId) : {})
    };
    const runtimeToolBinding = context.presentation === "provider_command"
      ? undefined
      : this.runtimeToolProvider?.forRun(session, context, agent);
    const request = {
      instance: agent,
      localSessionId: session.id,
      prompt,
      cwd: context.workingDirectory ?? project?.rootPath ?? process.cwd(),
      model: session.model,
      reasoningEffort,
      agentMode: session.agentMode,
      serviceTier: session.serviceTier,
      permissionMode: session.permissionMode?.trim() || (typeof agent.providerOptions?.permissionMode === "string" ? agent.providerOptions.permissionMode.trim() || undefined : undefined),
      contextWindow,
      env: selectedConnection ? connectionEnvironment(selectedConnection, agent, this.environment.build(policy, additions), this.credentials, this.adapters.find(agent.providerId)?.descriptor) : isolateLoginProfile(agent, this.environment.build(policy, additions)),
      timeoutMs: context.providerCommand === "compact" ? 5 * 60_000 : 30 * 60_000,
      idleTimeoutMs: 30 * 60_000,
      localImagePaths: context.localImagePaths,
      providerCommand: context.providerCommand,
      imageGeneration: context.presentation === "provider_command" ? undefined : imageGenerationExecutor(this.database, this.credentials, agent, session, context.workingDirectory ?? project?.rootPath ?? process.cwd()),
      skills: this.resolveSkills(agent),
      mcpServers: this.resolveMcpServers(agent),
      ...(runtimeToolBinding ? { runtimeTools: runtimeToolBinding.tools, executeRuntimeTool: runtimeToolBinding.execute } : {}),
      ...(this.interactions && context.presentation !== "provider_command"
        ? { requestInteraction: (input: AdapterInteractionInput) => this.interactions!.request(session, runId, agent.providerId, input) }
        : {})
    };

    let connectionProxy: { close(): Promise<void> } | undefined;
    try {
      if (selectedConnection?.kind === "login") {
        if (selectedConnection.harness !== agent.providerId) {
          if (!this.accountGateways) throw Error("Account credential service unavailable");
          await this.accountGateways.bind(session.id, selectedConnection, request);
        } else {
          await checkNativeAccountLogin(selectedConnection, request);
        }
      }
    } catch (error) {
      this.failRun(run, session, error, context.presentation === "provider_command");
      throw error;
    }
    this.requestLogs.supplied(context.requestId,request.runtimeTools,request.mcpServers);
    this.requestLogs.mark(context.requestId,"dispatched");
    let streamObserver: Awaited<ReturnType<typeof startApiStreamObserver>>;
    try {
      const adapter = this.adapters.find(agent.providerId);
      if (selectedConnection && adapter?.descriptor?.observeApiOutput) streamObserver = await startApiStreamObserver(request);
      const native = selectedConnection && adapter?.connectionProtocol
        ? await adapter.connectionProtocol(request)
        : adapter?.descriptor?.nativeApiProtocol;
      const source = request.instance.providerOptions?.apiType;
      if (selectedConnection && native === "responses" && (source === "openai-completions" || source === "anthropic-messages")) {
        const config = { remoteBaseUrl: String(request.instance.providerOptions?.baseUrl), environment: request.env };
        const proxy = source === "anthropic-messages" ? await startAnthropicCompatProxy(config) : await startChatCompatProxy(config);
        connectionProxy = proxy;
        const key = request.env?.NAUTILO_CONNECTION_API_KEY;
        const localKey = proxy.token ?? randomUUID();
        request.env = Object.fromEntries(Object.entries(request.env ?? {}).map(([name, value]) => [name, value === key ? localKey : value]));
        request.env.OPENAI_BASE_URL = proxy.baseUrl;
        request.instance = { ...request.instance, providerOptions: { ...request.instance.providerOptions, baseUrl: proxy.baseUrl, apiType: "openai-responses" } };
      } else if (selectedConnection && native === "anthropic") {
        const proxy = await startClaudeApiProxy(request);
        if (proxy) {
          connectionProxy = proxy; request.env = Object.fromEntries(Object.entries(proxy.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
          request.instance = { ...request.instance, providerOptions: { ...request.instance.providerOptions, baseUrl: proxy.env.ANTHROPIC_BASE_URL!, apiType: "anthropic-messages" } };
        }
      }
      if (context.presentation !== "provider_command") {
        const isGitWorkspace = await this.diffCollector.isGitWorkspace(request.cwd).catch(() => false);
        if (!isGitWorkspace && project?.nonGitDiffMode !== "off") {
          const snapshot = await captureWorkspaceSnapshot(request.cwd).catch(() => undefined);
          if (snapshot) this.workspaceBaselines.set(runId, snapshot);
        }
      }
      this.assertRunning();
      const currentSession = this.database.sessions.get(session.id) ?? session;
      const mustRecreateCodexThread = agent.providerId === "codex"
        && (currentSession.runtimeToolVersion === 0 || Boolean(runtimeToolBinding)
          && currentSession.runtimeToolVersion !== RUNTIME_TOOL_SCHEMA_VERSION);
      const nativeRun = !currentSession.connectionContextRebuildRequired && currentSession.providerSessionId && this.adapters.capabilities(agent).nativeResume && !this.requiresProviderRecovery(currentSession, agent) && !mustRecreateCodexThread
        ? this.adapters.resume({ ...request, providerSessionId: currentSession.providerSessionId })
        : this.adapters.start(request);
      const adapterRun = streamObserver ? streamObserver.wrap(nativeRun) : nativeRun;
      const events = async function* () {
        try { yield* adapterRun.events; }
        finally { await connectionProxy?.close(); }
      }();
      const completion = this.consume(run, currentSession, events, {
        ...context,
        runtimeToolVersion: context.runtimeToolVersion ?? (context.presentation !== "provider_command" ? RUNTIME_TOOL_SCHEMA_VERSION : undefined),
        contextWindowOverride: configuredContextWindow ?? context.contextWindowOverride
      }).then(result => {
        this.requestLogs.finish(context.requestId,result.run.status,result.run.failureCode);
        return result;
      });
      this.active.set(runId, { sessionId: session.id, cancel: async () => { request.imageGeneration?.cancel(); await adapterRun.cancel(); await connectionProxy?.close(); }, steer: adapterRun.steer, completion, projectRunId: context.projectRunId });
      void completion.finally(() => {
        request.imageGeneration?.cancel();
        this.active.delete(runId);
        this.interactions?.cancelForRun(runId);
      });
      return { runId, completion };
    } catch (error) {
      await connectionProxy?.close();
      await streamObserver?.close();
      this.workspaceBaselines.delete(runId);
      const failed = this.failRun(run, session, error, context.presentation === "provider_command");
      this.requestLogs.finish(context.requestId,failed.status,failed.failureCode,error instanceof Error ? error.message : String(error));
      return { runId, completion: Promise.resolve({ run: failed, messages: [] }) };
    }
  }

  /** User-managed MCP servers enabled for this run's provider, with env passthrough resolved. */
  requiresProviderRecovery(session: Session, agent: AgentInstance): boolean {
    const adapter = this.adapters.find(agent.providerId);
    return !adapter?.capabilities.nativeResume || !!(adapter.descriptor?.nativeContextVersion && adapter.descriptor.nativeContextVersion !== session.providerContextVersion);
  }

  private resolveMcpServers(agent: AgentInstance): AdapterMcpServer[] {
    return this.database.capabilities.list()
      .filter((capability) => capability.enabled && capability.providerIds.includes(agent.providerId))
      .map((capability) => capabilityToMcpServer(capability))
      .filter((server): server is AdapterMcpServer => server !== undefined);
  }

  /** Provider-neutral skill bundles; each adapter decides how its CLI loads them. */
  private resolveSkills(agent: AgentInstance): AdapterSkill[] {
    return this.database.capabilities.list()
      .filter((capability) => capability.kind === "skill"
        && capability.enabled
        && capability.providerIds.includes(agent.providerId)
        && Boolean(capability.skill?.instructions.trim()))
      .map((capability) => ({
        id: capability.id,
        name: capability.name,
        description: capability.description,
        instructions: capability.skill!.instructions,
        resourceDir: capability.skill!.resourceDir
      }));
  }

  private async consume(
    run: AgentRun,
    session: Session,
    adapterEvents: AsyncIterable<AdapterEvent>,
    context: RunContext
  ): Promise<RunCompletion> {
    const messages: Message[] = [];
    let providerError: string | undefined;
    try {
      for await (const event of adapterEvents) {
        if (event.kind === "error") providerError = this.redaction.text(event.error.message);
        const message = await this.persist(run, session, event, context);
        if (message) messages.push(message);
      }
      const partial = this.messageBuffers.get(run.id);
      this.messageBuffers.delete(run.id);
      for (const [messageId, text] of partial ?? []) {
        if (!messageId.startsWith("sub:") && text) {
          const message = await this.persist(run, session, { kind: "message", messageId, text, phase: "completed" }, context);
          if (message) messages.push(message);
        }
      }
      if (context.presentation !== "provider_command") await this.collectRunDiff(run, session, context);
      const latest = this.database.runs.get(run.id) ?? run;
      const failedStatuses: AgentRun["status"][] = ["failed", "timed_out", "cancelled", "cancelling", "crashed"];
      if (failedStatuses.includes(latest.status)) {
        const cancelled = latest.status === "cancelled" || latest.status === "cancelling";
        const detail = cancelled
          ? "CLI process cancelled"
          : providerError?.trim() || this.outputTails.get(run.id)?.trim() || runFailureDetail(latest);
        if (cancelled) {
          this.events.append(session, latest, "run.cancelled", { reason: "user" });
        } else if (context.presentation !== "provider_command") {
          this.events.append(session, latest, "run.failed", {
            code: latest.failureCode ?? "RUN_START_FAILED",
            message: detail.slice(-4_000),
            connectionId: session.connectionId,
            retryable: !cancelled && latest.failureCode !== "AGENT_NOT_AUTHENTICATED"
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
      if (context.presentation !== "provider_command" && session.connectionContextRebuildRequired) {
        const current = this.database.sessions.get(session.id);
        if (current && current.connectionId === session.connectionId && current.connectionRevision === session.connectionRevision) {
          this.database.sessions.save({ ...current, connectionContextRebuildRequired: false });
        }
      }
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
    const current = this.database.runs.get(run.id) ?? run;
    if (current.status === "cancelled" || current.status === "cancelling") {
      this.events.append(session, current, "run.cancelled", { reason: "user" });
      this.updateSessionStatus(session.id, "idle");
      return current;
    }
    const failed: AgentRun = {
      ...current,
      status: "failed",
      endedAt: new Date().toISOString(),
      failureCode: error instanceof CoreError ? error.descriptor.code : "RUN_START_FAILED"
    };
    this.database.runs.save(failed);
    this.audit?.record({ actorType: "agent", actorId: run.memberId ?? session.memberId, action: "run.failed", resourceType: "run", resourceId: run.id, outcome: "failure", details: { failureCode: failed.failureCode, error: error instanceof Error ? error.message : String(error) } });
    if (!providerCommand) {
      this.events.append(session, failed, "run.failed", {
        code: failed.failureCode ?? "RUN_START_FAILED",
        message: error instanceof Error ? error.message : String(error),
        connectionId: session.connectionId,
        retryable: error instanceof CoreError ? error.descriptor.retryable : true
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
    this.requestLogs.observe(context.requestId,event);
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
        this.events.append(session, run, "agent.message", { messageId: event.subagentDispatchId ? bufferKey : message.id, providerMessageId: bufferKey, text: message.text, subagentDispatchId: event.subagentDispatchId });
      }
      return message;
    }
    if (event.kind === "thinking" && event.phase === "delta") {
      if (context.presentation !== "provider_command") this.events.append(session, run, "agent.thinking_delta", { messageId: event.messageId ?? "default", text: this.redaction.text(event.text), subagentDispatchId: event.subagentDispatchId });
    }
    else if (event.kind === "thinking") {
      if (context.presentation !== "provider_command") this.events.append(session, run, "agent.thinking_summary", { messageId: event.messageId, text: this.redaction.text(event.text), subagentDispatchId: event.subagentDispatchId });
    }
    else if (event.kind === "extension_ui") {
      const raw = event.raw as { targetId?: string } | undefined;
      if (event.method === "cancel" && raw?.targetId) this.interactions?.cancelNative(run.id, raw.targetId);
      this.events.append(session, run, "provider.extension_ui", { method: event.method, key: event.key, text: event.text, raw: event.raw });
    }
    else if (event.kind === "status") {
      if (event.phase === "runtime_ready" || event.phase === "runtime_capabilities") {
        const type = event.phase === "runtime_ready" ? "provider.runtime_ready" : "provider.runtime_capabilities";
        this.events.append(session, run, type, event.raw as never);
        return undefined;
      }
      if (context.presentation !== "provider_command") this.events.append(session, run, "agent.status", { phase: event.phase });
    }
    else if (event.kind === "session") {
      const current = this.database.sessions.get(session.id) ?? session;
      const now = new Date().toISOString();
      this.database.sessions.save({
        ...current,
        providerSessionId: event.providerSessionId,
        nativeWorkingDirectory: context.workingDirectory ?? current.nativeWorkingDirectory,
        providerContextSyncedAt: now,
        providerContextVersion: this.adapters.find(this.database.agents.get(run.agentInstanceId)?.providerId ?? "")?.descriptor?.nativeContextVersion,
        runtimeToolVersion: context.runtimeToolVersion ?? current.runtimeToolVersion,
        updatedAt: now
      });
    } else if (event.kind === "usage") {
      this.events.append(session, run, "usage.updated", {
        agentInstanceId: run.agentInstanceId,
        usageScope: event.usageScope,
        usageKey: event.usageKey ?? (event.usageScope === "turn" ? run.id : event.usageScope === "session" ? (this.database.sessions.get(session.id)?.providerSessionId ?? session.id) : undefined),
        inputTokensIncludesCache: event.inputTokensIncludesCache,
        cachedInputTokens: event.cachedInputTokens,
        cacheCreationInputTokens: event.cacheCreationInputTokens,
        reasoningOutputTokens: event.reasoningOutputTokens,
        reportedCost: event.reportedCost,
        estimatedCost: event.estimatedCost,
        currency: event.currency,
        connectionId: run.connectionId,
        connectionRevision: run.connectionRevision,
        model: run.model,
        pricingSnapshot: run.pricingSnapshot,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        contextUsed: event.contextUsed,
        contextWindow: context.contextWindowOverride ?? event.contextWindow
      });
      // Provider-reported windows are ground truth (raw is set only on live
      // provider usage, not on computed fallbacks): persist the window so
      // future runs can prefer it over a stale model-catalog entry.
      if (event.raw && event.contextWindow && event.contextWindow > 0) {
        const current = this.database.sessions.get(session.id);
        if (current && current.providerContextWindow !== event.contextWindow) {
          this.database.sessions.save({ ...current, providerContextWindow: event.contextWindow, updatedAt: new Date().toISOString() });
        }
      }
    }
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
      codeExecution: this.codeExecution(event.raw),
      subagent: subagentMeta(event.name, event.input),
      subagentDispatchId: event.subagentDispatchId
    });
    else if (event.kind === "tool" && event.phase === "updated") this.events.append(session, run, "tool.updated", {
      callId: event.callId, toolName: event.name,
      inputSummary: this.eventDetail(event.input, this.toolInputLimit(event.name)),
      outputSummary: this.eventDetail(event.output, 2_000),
      codeExecution: this.codeExecution(event.raw),
      subagent: subagentMeta(event.name, event.input), subagentDispatchId: event.subagentDispatchId
    });
    else if (event.kind === "tool") this.events.append(session, run, "tool.started", {
      callId: event.callId,
      toolName: event.name,
      inputSummary: this.eventDetail(event.input, this.toolInputLimit(event.name)),
      fileDiff: this.eventFileDiff(event.fileDiff),
      subagent: subagentMeta(event.name, event.input),
      codeExecution: this.codeExecution(event.raw),
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
    else if (event.kind === "command" && event.phase === "updated") this.events.append(session, run, "command.updated", {
      callId: event.callId, command: event.command,
      outputSummary: event.output ? this.redaction.text(event.output.slice(0, 2_000)) : undefined,
      subagentDispatchId: event.subagentDispatchId
    });
    else if (event.kind === "command") this.events.append(session, run, "command.started", { callId: event.callId, command: event.command, cwd: context.workingDirectory ?? this.database.projects.get(session.projectId)?.rootPath ?? process.cwd(), subagentDispatchId: event.subagentDispatchId });
    else if (event.kind === "turn_diff") {
      const diff = this.redaction.text(event.diff);
      const metadata = { runId: run.id, source: "provider", threadId: event.threadId, turnId: event.turnId };
      const content = JSON.stringify({ files: [], diff, ...metadata });
      const artifactId = `native-diff:${run.id}`;
      if (this.database.artifacts.get(artifactId)?.content === content) return undefined;
      const artifact = this.artifactService.save({
        kind: "diff", name: `${session.title.slice(0, 80) || "run"}.native.diff.json`,
        content,
        projectRunId: context.projectRunId, taskId: context.taskId, sessionId: session.id, metadata
      }, artifactId);
      this.events.append(session, run, "run.diff_updated", {
        diff, providerThreadId: event.threadId, providerTurnId: event.turnId, source: "provider"
      });
      this.events.append(session, run, "artifact.created", { artifactId: artifact.id, kind: "diff", name: artifact.name });
    }
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
      // A provider process can exit cleanly after reporting a model/transport
      // failure (Pi RPC is one example). Do not let exit code 0 erase the
      // earlier failed/timed-out state and leave a misleading completed run.
      if (!["failed", "timed_out", "cancelled", "cancelling", "crashed"].includes(current.status)) {
        this.database.runs.save({ ...current, status: event.exitCode === 0 ? "completed" : "failed", endedAt: new Date().toISOString(), exitCode: event.exitCode ?? undefined });
      }
    } else if (event.kind === "timeout" && !["cancelling", "cancelled"].includes(this.database.runs.get(run.id)?.status ?? "")) this.database.runs.save({
      ...(this.database.runs.get(run.id) ?? run),
      status: event.reason === "max_output" ? "failed" : "timed_out",
      endedAt: new Date().toISOString(),
      failureCode: `RUN_${event.reason.toUpperCase()}`
    });
    else if (event.kind === "error") {
      this.rememberOutput(run.id, event.error.message);
      const current = this.database.runs.get(run.id) ?? run;
      const authentication = session.connectionId && this.database.runtimeConnections.get(session.connectionId)?.kind === "login" && isAccountAuthenticationError(event.error.message);
      if (!["cancelling", "cancelled"].includes(current.status)) this.database.runs.save({ ...current, status: "failed", endedAt: new Date().toISOString(), failureCode: authentication ? "AGENT_NOT_AUTHENTICATED" : "PROVIDER_ERROR" });
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
    return normalized === "run_code" ? 256_000 : ["todolist", "todo_list", "todowrite", "todo_write", "update_plan"].includes(normalized) ? 16_000 : 2_000;
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

  private codeExecution(raw: unknown): import("@agenthub/event-protocol").CodeExecution | undefined {
    if (!raw || typeof raw !== "object" || !("codeExecution" in raw)) return undefined;
    if (!raw.codeExecution || typeof raw.codeExecution !== "object" || !("calls" in raw.codeExecution) || !Array.isArray(raw.codeExecution.calls)) return undefined;
    return this.redaction.value(raw.codeExecution) as import("@agenthub/event-protocol").CodeExecution;
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
    const baseline = this.workspaceBaselines.get(run.id);
    // Native cumulative diffs are authoritative even when empty. Non-Git
    // off mode needs no synthetic missing-baseline artifact. Git remains unchanged.
    const nativeDiff = this.database.artifacts.get(`native-diff:${run.id}`);
    if (nativeDiff && project?.nonGitDiffMode === "off" && await this.diffCollector.isNonGitWorkspace(cwd).catch(() => false)) return;
    const comparisonUnavailable = !baseline && await this.diffCollector.isNonGitWorkspace(cwd).catch(() => false);
    const files = comparisonUnavailable ? [] : await this.diffCollector.collect(cwd, touched, baseline).catch(() => []);
    if (!files.length && !comparisonUnavailable) return;
    const paths = comparisonUnavailable ? touched.map((file) => file.path) : files.map((file) => file.path);
    const unavailable: Record<string, string | number | boolean | string[]> = comparisonUnavailable
      ? { comparisonUnavailable: true, reason: "non_git_baseline_unavailable", paths }
      : {};
    const unavailableFiles = files.filter((file) => file.comparisonUnavailable).map((file) => file.path);
    if (unavailableFiles.length) Object.assign(unavailable, { comparisonUnavailable: true, reason: "file_versions_unavailable", unavailablePaths: unavailableFiles });
    const artifact = this.artifactService.save({
      kind: "diff",
      name: `${session.title.slice(0, 80) || "run"}.diff.json`,
      content: JSON.stringify({ files, source: "filesystem", ...unavailable }),
      projectRunId: context.projectRunId,
      taskId: context.taskId,
      sessionId: session.id,
      metadata: { runId: run.id, source: "filesystem", paths, fileCount: files.length, ...unavailable }
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

function runFailureDetail(run: AgentRun): string {
  if (run.failureCode === "RUN_MAX_OUTPUT") return "CLI output exceeded the configured safety limit";
  if (run.failureCode === "RUN_IDLE") return "CLI process was idle for too long";
  if (run.failureCode === "RUN_TIMEOUT") return "CLI process exceeded the configured time limit";
  return run.status === "timed_out" ? "CLI process timed out" : "CLI process failed";
}
