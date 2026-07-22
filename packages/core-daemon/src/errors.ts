import { createAgentHubError, type AgentHubError, type AgentHubErrorCode } from "@agenthub/domain";

export class CoreError extends Error {
  readonly descriptor: AgentHubError;
  constructor(code: AgentHubErrorCode, details?: Record<string, unknown>) {
    const descriptor = createAgentHubError(code, details);
    super(descriptor.message);
    this.name = "CoreError";
    this.descriptor = descriptor;
  }
}

export function toAgentHubError(error: unknown): AgentHubError {
  return error instanceof CoreError
    ? error.descriptor
    : createAgentHubError("IPC_INTERNAL_ERROR", { cause: error instanceof Error ? error.message : String(error) });
}
