import type { AgentInstance, ProviderModelCatalog } from "@agenthub/domain";
import type { ProcessHandle } from "../process-runtime.js";

export type AdapterEvent =
  | { kind: "message"; text: string; phase?: "delta" | "completed"; messageId?: string; raw?: unknown }
  | { kind: "thinking"; text: string; phase?: "delta" | "completed"; messageId?: string; raw?: unknown }
  | { kind: "tool"; callId?: string; name: string; phase?: "started" | "completed"; input?: unknown; output?: unknown; success?: boolean; raw?: unknown }
  | { kind: "command"; callId?: string; command: string; phase?: "started" | "completed"; exitCode?: number; output?: string; raw?: unknown }
  | { kind: "file"; path: string; changeType?: string; raw?: unknown }
  | { kind: "session"; providerSessionId: string; raw?: unknown }
  | { kind: "status"; phase: "turn_started" | "turn_completed" | "turn_failed"; raw?: unknown }
  | { kind: "usage"; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number; contextUsed?: number; contextWindow?: number; raw?: unknown }
  | { kind: "commands"; commands: Array<{ name: string; description: string; inputHint?: string }>; raw?: unknown }
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
  contextWindow?: number;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  outputSchemaPath?: string;
  localImagePaths?: string[];
}

export interface AdapterResumeRequest extends AdapterStartRequest {
  providerSessionId: string;
}

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
  write(input: string): void;
}

export interface AgentCliAdapter {
  readonly providerId: string;
  readonly supportsStructuredOutput: boolean;
  readonly supportsResume: boolean;
  readonly capabilities: AdapterCapabilities;
  detect(instance: AgentInstance): Promise<AdapterDetectionResult>;
  listModels?(instance: AgentInstance, context?: AdapterDiscoveryContext): Promise<ProviderModelCatalog>;
  start(request: AdapterStartRequest): AdapterRun;
  resume?(request: AdapterResumeRequest): AdapterRun;
}
