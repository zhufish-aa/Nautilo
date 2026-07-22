import type { AgentInstance } from "@agenthub/domain";
import { appendPrompt, ProcessAdapter } from "./process-adapter.js";
import type { AdapterStartRequest } from "./types.js";
export class ClaudeCodeAdapter extends ProcessAdapter {
  readonly providerId = "claude-code";
  readonly supportsStructuredOutput = true;
  readonly supportsResume = true;
  protected commandArgs(instance: AgentInstance, prompt: string, request?: AdapterStartRequest): string[] { return appendPrompt(["-p", "--output-format", "stream-json", "--verbose"], instance, prompt, request); }
  protected resumeArgs(instance: AgentInstance, sessionId: string, prompt: string): string[] { return instance.baseArgs.length ? [...instance.baseArgs, "--resume", sessionId, prompt] : ["-p", "--resume", sessionId, "--output-format", "stream-json", prompt]; }
}
