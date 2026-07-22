import type { AgentInstance } from "@agenthub/domain";
import type { AdapterStartRequest } from "../types.js";

function defaultArgs(request?: AdapterStartRequest): string[] {
  return request?.model ? ["--model", request.model] : [];
}

export function buildKimiStartArgs(instance: AgentInstance, prompt: string, request?: AdapterStartRequest): string[] {
  const args = instance.baseArgs.length ? [...instance.baseArgs] : defaultArgs(request);
  return [...args, "--prompt", prompt, "--output-format", "stream-json"];
}

export function buildKimiResumeArgs(instance: AgentInstance, sessionId: string, prompt: string, request?: AdapterStartRequest): string[] {
  const args = instance.baseArgs.length ? [...instance.baseArgs] : defaultArgs(request);
  return [...args, "--session", sessionId, "--prompt", prompt, "--output-format", "stream-json"];
}
