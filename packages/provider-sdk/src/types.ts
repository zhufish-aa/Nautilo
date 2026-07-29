import type { AgentInstance, InteractionRequest, InteractionResponse, ProviderModelCatalog } from "@agenthub/domain";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

// Domain types referenced by the contract, re-exported so plugin authors only
// depend on the SDK (type-only — nothing is emitted at runtime).
export type {
  AgentInstance,
  InteractionOption,
  InteractionPlan,
  InteractionQuestion,
  InteractionRequest,
  InteractionResponse,
  ProviderModel,
  ProviderModelCatalog
} from "@agenthub/domain";

/**
 * Public contract between AgentHub and a provider (agent CLI) adapter.
 *
 * These types are the stable plugin API surface: built-in adapters in
 * core-daemon and third-party provider plugins implement the same
 * `AgentCliAdapter` interface. `PROVIDER_API_VERSION` (see index.ts) is
 * bumped whenever this contract changes incompatibly.
 */

export interface AdapterFileDiff {
  operation?: "edit" | "write";
  path?: string;
  before: string;
  after: string;
}

/**
 * `subagentDispatchId` marks activity produced inside a provider-native
 * sub-agent: it is the callId of the dispatching tool call (Claude's
 * parent_tool_use_id, opencode's child-session task part, Codex's collab
 * tool call item). Absent for the main agent's own activity.
 */
export type AdapterEvent =
  | { kind: "message"; text: string; phase?: "delta" | "completed"; messageId?: string; subagentDispatchId?: string; raw?: unknown }
  | { kind: "thinking"; text: string; phase?: "delta" | "completed"; messageId?: string; subagentDispatchId?: string; raw?: unknown }
  | { kind: "tool"; callId?: string; name: string; phase?: "started" | "completed"; input?: unknown; output?: unknown; success?: boolean; fileDiff?: AdapterFileDiff; subagentDispatchId?: string; raw?: unknown }
  | { kind: "command"; callId?: string; command: string; phase?: "started" | "completed"; exitCode?: number; output?: string; subagentDispatchId?: string; raw?: unknown }
  | { kind: "file"; path: string; changeType?: string; additions?: number; deletions?: number; diff?: string; raw?: unknown }
  | { kind: "session"; providerSessionId: string; raw?: unknown }
  | { kind: "status"; phase: "turn_started" | "turn_completed" | "turn_failed"; raw?: unknown }
  | { kind: "usage"; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number; contextUsed?: number; contextWindow?: number; raw?: unknown }
  | { kind: "commands"; commands: Array<{ name: string; description: string; inputHint?: string; providerCommand?: "compact" }>; raw?: unknown }
  | { kind: "artifact"; artifactType: "image" | "file"; name: string; mimeType?: string; data?: string; path?: string; raw?: unknown }
  | { kind: "raw"; stream: "stdout" | "stderr"; text: string }
  | { kind: "exit"; exitCode: number | null; signal?: string }
  | { kind: "error"; error: Error }
  | { kind: "timeout"; reason: "timeout" | "idle" | "max_output" };

export interface AdapterStartRequest {
  instance: AgentInstance;
  prompt: string;
  cwd: string;
  /** Session-scoped execution settings; these do not belong to AgentInstance. */
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  /** Session-scoped CLI permission mode; overrides the instance-level setting. */
  permissionMode?: string;
  contextWindow?: number;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  outputSchemaPath?: string;
  localImagePaths?: string[];
  /** Tools supplied by AgentHub for this provider session, such as delegation. */
  runtimeTools?: RuntimeToolSpec[];
  executeRuntimeTool?: RuntimeToolExecutor;
  /**
   * Provider-initiated user interaction (structured question or permission
   * prompt). The adapter must block the provider request until this resolves;
   * when absent, adapters fall back to their previous auto-answer behavior.
   */
  requestInteraction?: (input: AdapterInteractionInput) => Promise<InteractionResponse>;
  /** User-managed MCP servers enabled for this provider; injected at session start. */
  mcpServers?: AdapterMcpServer[];
  /**
   * Provider-native control command for this run. Adapters that have a
   * dedicated transport for it (e.g. Codex app-server thread/compact/start)
   * should honor it instead of sending the command text as a chat prompt.
   */
  providerCommand?: "compact";
}

export interface AdapterResumeRequest extends AdapterStartRequest {
  providerSessionId: string;
}

/** User-managed MCP server resolved for one provider session. */
export interface AdapterMcpServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** Interaction payload supplied by an adapter; the daemon fills in session/run metadata. */
export type AdapterInteractionInput = Pick<InteractionRequest, "kind" | "title" | "detail" | "questions" | "options" | "plan">;

export interface AdapterCapabilities {
  structuredOutput: boolean;
  textOutput: boolean;
  interactiveStdin: boolean;
  nativeResume: boolean;
  pty: boolean;
}

export interface AdapterDetectionResult {
  installed: boolean;
  compatible?: boolean;
  executable: string;
  version?: string;
  help?: string;
  error?: string;
}

export interface AdapterDiscoveryContext {
  /** Sanitized instance-scoped environment, including locally stored credentials. */
  env?: Record<string, string | undefined>;
}

export interface AdapterRun {
  readonly process: ProcessHandle;
  readonly events: AsyncIterable<AdapterEvent>;
  cancel(): Promise<void>;
  /** Adds input to the provider's currently active turn when it supports steering. */
  steer?(input: string): Promise<void>;
  write(input: string): void;
}

export interface AgentCliAdapter {
  readonly providerId: string;
  readonly descriptor: import("./descriptor.js").ProviderDescriptor;
  readonly supportsStructuredOutput: boolean;
  readonly supportsResume: boolean;
  readonly capabilities: AdapterCapabilities;
  detect(instance: AgentInstance): Promise<AdapterDetectionResult>;
  listModels?(instance: AgentInstance, context?: AdapterDiscoveryContext): Promise<ProviderModelCatalog>;
  start(request: AdapterStartRequest): AdapterRun;
  resume?(request: AdapterResumeRequest): AdapterRun;
}

/* ------------------------------------------------------------------ */
/* Process contract (implemented by the host's process runtime).       */
/* ------------------------------------------------------------------ */

export interface ProcessRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
}

export type ProcessEvent =
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "exit"; exitCode: number | null; signal?: string }
  | { kind: "error"; error: Error }
  | { kind: "timeout"; reason: "timeout" | "idle" | "max_output" };

export interface ProcessHandle {
  readonly pid?: number;
  readonly events: AsyncIterable<ProcessEvent>;
  readonly child: ChildProcessWithoutNullStreams;
  write(input: string): void;
  cancel(): Promise<void>;
  wait(): Promise<{ exitCode: number | null; signal?: string }>;
}

/* ------------------------------------------------------------------ */
/* Runtime tools supplied by the host (delegation etc.).               */
/* ------------------------------------------------------------------ */

export interface RuntimeToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RuntimeToolCall {
  callId?: string;
  name: string;
  arguments: unknown;
  providerId: string;
}

export interface RuntimeToolResult {
  success: boolean;
  content: string;
}

export type RuntimeToolExecutor = (call: RuntimeToolCall) => Promise<RuntimeToolResult>;
