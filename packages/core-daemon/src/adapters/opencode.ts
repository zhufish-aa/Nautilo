import type { AgentInstance } from "@agenthub/domain";
import { appendPrompt, ProcessAdapter } from "./process-adapter.js";
import type { AdapterStartRequest } from "./types.js";
export class OpenCodeAdapter extends ProcessAdapter {
  readonly providerId = "opencode";
  readonly supportsStructuredOutput = true;
  readonly supportsResume = true;
  protected commandArgs(instance: AgentInstance, prompt: string, request?: AdapterStartRequest): string[] { return appendPrompt(["run", "--format", "json"], instance, prompt, request); }
  protected resumeArgs(instance: AgentInstance, sessionId: string, prompt: string): string[] { return instance.baseArgs.length ? [...instance.baseArgs, "--session", sessionId, prompt] : ["run", "--session", sessionId, "--format", "json", prompt]; }
}
