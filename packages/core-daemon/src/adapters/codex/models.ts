import type { AgentInstance, ProviderModel, ProviderModelCatalog } from "@agenthub/domain";
import { ProcessRuntime } from "../../process-runtime.js";
import { EnvironmentPolicyService } from "../../runtime/security/environment-policy.js";
import type { AdapterDiscoveryContext } from "../types.js";
import { buildCodexAppServerArgs, CODEX_APP_SERVER_INITIALIZE_PARAMS } from "./app-server-run.js";
import { resolveCodexInvocation } from "./executable.js";

interface JsonRpcResponse {
  id?: string | number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface CodexModelListResponse {
  data?: unknown[];
  nextCursor?: string | null;
}

const DEFAULT_CODEX_API_BASE_URL = "https://api.openai.com/v1";

/**
 * Reasoning efforts offered as suggestions when the API catalog omits them.
 * Codex treats the value as a free-form string advertised per model; the common
 * levels are listed so API-discovered models stay configurable, and the UI still
 * accepts custom values on top.
 */
const CODEX_API_MODEL_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];

/**
 * API-first discovery: query the OpenAI-compatible GET {baseUrl}/models with the
 * instance's stored credential; fall back to the local CLI app-server when no
 * credential/base URL is configured or the request fails.
 */
export async function discoverCodexModels(instance: AgentInstance, context?: AdapterDiscoveryContext): Promise<ProviderModelCatalog> {
  const environment = new EnvironmentPolicyService();
  const env = environment.build(undefined, context?.env);
  let apiWarning: string | undefined;
  try {
    const apiCatalog = await discoverCodexModelsViaApi(instance, env);
    if (apiCatalog) return apiCatalog;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[agenthub] codex API model discovery failed (${reason}); falling back to the local CLI`);
    apiWarning = `模型列表 API 请求失败（${reason}），已回退到本机 CLI 获取。`;
  }
  const catalog = await discoverCodexModelsViaCli(instance, env);
  return apiWarning ? { ...catalog, warning: apiWarning } : catalog;
}

async function discoverCodexModelsViaApi(instance: AgentInstance, env: Record<string, string>): Promise<ProviderModelCatalog | undefined> {
  const configured = instance.providerOptions?.baseUrl;
  const baseUrlOption = typeof configured === "string" && configured.trim() ? configured.trim() : env.OPENAI_BASE_URL?.trim();
  const apiKey = env.OPENAI_API_KEY?.trim() || env.CODEX_API_KEY?.trim();
  // Without an explicit base URL the API path only makes sense with a credential;
  // local no-auth endpoints (env_key-less providers) are reachable by URL alone.
  if (!baseUrlOption && !apiKey) return undefined;
  const baseUrl = (baseUrlOption || DEFAULT_CODEX_API_BASE_URL).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      accept: "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Codex API /models request failed (${response.status})`);
  const catalog = parseCodexApiModelList(await response.json());
  if (!catalog.models.length) throw new Error("Codex API /models returned an empty list");
  return catalog;
}

export function parseCodexApiModelList(value: unknown): ProviderModelCatalog {
  const data = asRecord(value).data;
  const models = (Array.isArray(data) ? data : [])
    .map((entry): ProviderModel | undefined => {
      const id = stringValue(asRecord(entry).id);
      if (!id) return undefined;
      return { id, displayName: id, isDefault: false, capabilities: [], reasoningEfforts: [...CODEX_API_MODEL_REASONING_EFFORTS], serviceTiers: [] };
    })
    .filter((model): model is ProviderModel => model !== undefined);
  return {
    providerId: "codex",
    models,
    source: "provider_api",
    fetchedAt: new Date().toISOString()
  };
}

/** Uses Codex's documented app-server model/list endpoint for the effective local catalog. */
async function discoverCodexModelsViaCli(instance: AgentInstance, env: Record<string, string>): Promise<ProviderModelCatalog> {
  const runtime = new ProcessRuntime();
  const invocation = resolveCodexInvocation(instance.executable, buildCodexAppServerArgs(instance, env), env.PATH);
  const process = runtime.start({
    command: invocation.command,
    args: invocation.args,
    env,
    timeoutMs: 20_000,
    idleTimeoutMs: 12_000,
    maxOutputBytes: 4 * 1024 * 1024
  });

  process.write(`${JSON.stringify({
    method: "initialize",
    id: 0,
    params: CODEX_APP_SERVER_INITIALIZE_PARAMS
  })}\n`);
  process.write(`${JSON.stringify({ method: "initialized" })}\n`);
  process.write(`${JSON.stringify({
    method: "model/list",
    id: 1,
    params: { limit: 200, includeHidden: false }
  })}\n`);

  let stdout = "";
  let stderr = "";
  try {
    for await (const event of process.events) {
      if (event.kind === "stdout") {
        stdout += event.text;
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let response: JsonRpcResponse;
          try { response = JSON.parse(line) as JsonRpcResponse; } catch { continue; }
          if (response.id !== 1) continue;
          if (response.error) throw new Error(response.error.message || `Codex model/list failed (${response.error.code ?? "unknown"})`);
          const catalog = parseCodexModelList(response.result);
          await process.cancel();
          return catalog;
        }
      } else if (event.kind === "stderr") {
        stderr = `${stderr}${event.text}`.slice(-8_192);
      } else if (event.kind === "timeout") {
        throw new Error("Codex 模型列表读取超时，请检查登录或配置。" );
      } else if (event.kind === "error") {
        throw event.error;
      } else if (event.kind === "exit" && event.exitCode !== 0) {
        throw new Error(stderr.trim() || `Codex app-server exited with ${event.exitCode ?? "unknown"}`);
      }
    }
    throw new Error(stderr.trim() || "Codex app-server 未返回模型列表。" );
  } finally {
    if (process.child.exitCode === null && !process.child.killed) await process.cancel().catch(() => undefined);
  }
}

export function parseCodexModelList(value: unknown): ProviderModelCatalog {
  const response = asRecord(value) as CodexModelListResponse;
  const models = Array.isArray(response.data)
    ? response.data.map(toProviderModel).filter((model): model is ProviderModel => model !== undefined)
    : [];
  const defaultModel = models.find((model) => model.isDefault)?.id;
  return {
    providerId: "codex",
    models,
    defaultModel,
    source: "provider_cli",
    fetchedAt: new Date().toISOString()
  };
}

function toProviderModel(value: unknown): ProviderModel | undefined {
  const model = asRecord(value);
  const id = stringValue(model.model) || stringValue(model.id);
  if (!id) return undefined;
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
      .map((entry) => stringValue(asRecord(entry).reasoningEffort))
      .filter((entry): entry is string => !!entry)
    : [];
  const serviceTiers = Array.isArray(model.serviceTiers)
    ? model.serviceTiers
      .map((entry) => {
        const tier = asRecord(entry);
        const tierId = stringValue(tier.id);
        if (!tierId) return undefined;
        return {
          id: tierId,
          name: stringValue(tier.name) || tierId,
          description: stringValue(tier.description)
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => !!entry)
    : [];
  return {
    id,
    displayName: stringValue(model.displayName) || id,
    description: stringValue(model.description),
    isDefault: model.isDefault === true,
    capabilities: [],
    reasoningEfforts: efforts,
    defaultReasoningEffort: stringValue(model.defaultReasoningEffort),
    serviceTiers,
    defaultServiceTier: stringValue(model.defaultServiceTier)
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
