import type { AgentInstance } from "@agenthub/domain";
import type { AdapterStartRequest } from "../types.js";
import { buildCodexProviderConfigArgs } from "./provider-config.js";

function defaultStartArgs(instance: AgentInstance, request?: AdapterStartRequest): string[] {
  const args = ["exec", "--json"];
  if (request?.model) args.push("--model", request.model);
  if (request?.reasoningEffort) args.push("--config", `model_reasoning_effort=${JSON.stringify(request.reasoningEffort)}`);
  if (request?.serviceTier && request.serviceTier !== "standard") args.push("--config", `service_tier=${JSON.stringify(request.serviceTier)}`);
  if (instance.profile) args.push("--profile", instance.profile);
  return args;
}

function defaultResumeArgs(request?: AdapterStartRequest): string[] {
  const args = ["exec", "resume", "--json"];
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
  const args = instance.baseArgs.length ? [...instance.baseArgs, "resume"] : defaultResumeArgs(request);
  args.push(...buildCodexProviderConfigArgs(instance, request?.env));
  return [...args, sessionId, prompt];
}
