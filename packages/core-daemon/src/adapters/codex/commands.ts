import type { AgentInstance } from "@agenthub/domain";
import type { AdapterStartRequest } from "../types.js";
import { buildCodexProviderConfigArgs } from "./provider-config.js";

/**
 * Maps the user-selected CLI-native permission mode onto Codex approval
 * policy + sandbox. A session-level override (request.permissionMode) wins
 * over the instance setting; unset keeps Codex's own defaults (exec path)
 * or the app-server defaults below.
 */
export function codexPermissionConfig(instance: AgentInstance, request?: AdapterStartRequest): { approvalPolicy: "on-request" | "on-failure" | "never"; sandbox: "workspace-write" | "danger-full-access" } | undefined {
  const instanceMode = typeof instance.providerOptions?.permissionMode === "string" ? instance.providerOptions.permissionMode : undefined;
  const mode = request?.permissionMode ?? instanceMode;
  switch (mode) {
    case "ask": return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "auto": return { approvalPolicy: "on-failure", sandbox: "workspace-write" };
    case "full-access": return { approvalPolicy: "never", sandbox: "danger-full-access" };
    default: return undefined;
  }
}

function permissionArgs(instance: AgentInstance, request?: AdapterStartRequest): string[] {
  const config = codexPermissionConfig(instance, request);
  return config ? ["--ask-for-approval", config.approvalPolicy, "--sandbox", config.sandbox] : [];
}

function defaultStartArgs(instance: AgentInstance, request?: AdapterStartRequest): string[] {
  const args = ["exec", "--json", ...permissionArgs(instance, request)];
  if (request?.model) args.push("--model", request.model);
  if (request?.reasoningEffort) args.push("--config", `model_reasoning_effort=${JSON.stringify(request.reasoningEffort)}`);
  if (request?.serviceTier && request.serviceTier !== "standard") args.push("--config", `service_tier=${JSON.stringify(request.serviceTier)}`);
  if (instance.profile) args.push("--profile", instance.profile);
  return args;
}

function defaultResumeArgs(instance: AgentInstance, request?: AdapterStartRequest): string[] {
  const args = ["exec", "resume", "--json", ...permissionArgs(instance, request)];
  if (request?.model) args.push("--model", request.model);
  if (request?.reasoningEffort) args.push("--config", `model_reasoning_effort=${JSON.stringify(request.reasoningEffort)}`);
  if (request?.serviceTier && request.serviceTier !== "standard") args.push("--config", `service_tier=${JSON.stringify(request.serviceTier)}`);
  return args;
}

export function buildCodexStartArgs(instance: AgentInstance, prompt: string, request?: AdapterStartRequest): string[] {
  const args = instance.baseArgs.length ? [...instance.baseArgs] : defaultStartArgs(instance, request);
  args.push(...buildCodexProviderConfigArgs(instance, request?.env));
  const schema = request?.outputSchemaPath
    ?? (typeof instance.providerOptions?.outputSchemaPath === "string" ? instance.providerOptions.outputSchemaPath : undefined);
  if (schema && !args.includes("--output-schema")) args.push("--output-schema", schema);
  return [...args, prompt];
}

export function buildCodexResumeArgs(instance: AgentInstance, sessionId: string, prompt: string, request?: AdapterStartRequest): string[] {
  const args = instance.baseArgs.length ? [...instance.baseArgs, "resume"] : defaultResumeArgs(instance, request);
  args.push(...buildCodexProviderConfigArgs(instance, request?.env));
  return [...args, sessionId, prompt];
}
