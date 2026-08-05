import type { InstanceModelConfig, ProviderModel, ProviderModelCatalog } from "@agenthub/domain";

/**
 * User-curated model config + generic OpenAI-compatible model discovery.
 *
 * The instance editor lets users pin a model list with per-model reasoning
 * efforts (ordered) and context window overrides. Live discovery stays the
 * base catalog; `mergeInstanceModelConfig` applies those overrides so every
 * consumer (member editor, session model control, context-window discovery)
 * sees the same effective list.
 */

/** Generic reasoning levels suggested for API-discovered models that omit effort metadata. */
export const GENERIC_MODEL_REASONING_EFFORTS = ["low", "medium", "high"];

/**
 * Merges an instance's curated model configuration into a discovered catalog.
 * Configured entries override the same model id (ordered reasoning efforts,
 * display name and context window) and unknown ids are appended so custom
 * models stay selectable even when the provider does not list them.
 */
export function mergeInstanceModelConfig(
  catalog: ProviderModelCatalog,
  models?: InstanceModelConfig[]
): ProviderModelCatalog {
  if (!models?.length) return catalog;
  const merged = [...catalog.models];
  for (const config of models) {
    const id = config.id.trim();
    if (!id) continue;
    const index = merged.findIndex((model) => model.id === id);
    if (index >= 0) {
      const existing = merged[index];
      merged[index] = {
        ...existing,
        displayName: config.displayName?.trim() || existing.displayName,
        reasoningEfforts: config.reasoningEfforts?.length ? [...config.reasoningEfforts] : existing.reasoningEfforts,
        contextWindow: config.contextWindow ?? existing.contextWindow
      };
    } else {
      merged.push({
        id,
        displayName: config.displayName?.trim() || id,
        isDefault: false,
        reasoningEfforts: [...(config.reasoningEfforts ?? [])],
        contextWindow: config.contextWindow,
        capabilities: [],
        serviceTiers: []
      });
    }
  }
  return { ...catalog, models: merged };
}

/**
 * Provider API model discovery against `GET {baseUrl}/models`.
 * Used by the instance editor's quick-fetch button when a base URL is
 * configured; requests without a credential are sent unauthenticated so
 * local endpoints (Ollama, vLLM, LM Studio, ...) work out of the box.
 *
 * Authentication follows the selected upstream protocol. Both the exact
 * base URL and its conventional versioned models route are tried; Anthropic
 * shims ending in `/anthropic` also retry against the parent endpoint.
 */
export async function discoverOpenAiCompatibleModels(
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 10_000,
  apiType?: string
): Promise<ProviderModelCatalog> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const endpoints = modelListEndpoints(normalized, apiType);
  let lastError: unknown;
  for (const endpoint of endpoints) {
    try {
      return await fetchModels(endpoint, apiKey, timeoutMs, apiType);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Unable to fetch models from ${normalized}`);
}

function modelListEndpoints(baseUrl: string, apiType?: string): string[] {
  const roots = [baseUrl];
  const strippedAnthropic = baseUrl.replace(/\/anthropic$/i, "");
  if (strippedAnthropic !== baseUrl) roots.push(strippedAnthropic);
  const suffix = apiType === "google-generative-ai" ? "v1beta" : "v1";
  return [...new Set(roots.flatMap((root) => [
    `${root}/models`,
    ...(/\/(?:v1|v1beta)$/i.test(root) ? [] : [`${root}/${suffix}/models`])
  ]))];
}

function modelListHeaders(apiKey: string | undefined, apiType?: string): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (!apiKey) return headers;
  if (apiType === "anthropic-messages") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiType === "google-generative-ai") {
    headers["x-goog-api-key"] = apiKey;
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function fetchModels(endpoint: string, apiKey: string | undefined, timeoutMs: number, apiType?: string): Promise<ProviderModelCatalog> {
  const response = await fetch(endpoint, {
    headers: modelListHeaders(apiKey, apiType),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`GET ${endpoint} failed (${response.status})`);
  const parsed = parseOpenAiCompatibleModelList(await response.json());
  if (!parsed.models.length) throw new Error(`GET ${endpoint} returned no models`);
  return parsed;
}

/** Normalizes OpenAI-compatible `/models` payloads (`data` or `models` arrays). */
export function parseOpenAiCompatibleModelList(value: unknown): ProviderModelCatalog {
  const root = asRecord(value);
  const entries = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  const models = entries
    .map((entry): ProviderModel | undefined => {
      const record = asRecord(entry);
      const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;
      if (!id) return undefined;
      const rawName = typeof record.display_name === "string" && record.display_name.trim()
        ? record.display_name.trim()
        : typeof record.name === "string" && record.name.trim()
          ? record.name.trim()
          : "";
      return {
        id,
        displayName: rawName || id,
        isDefault: false,
        reasoningEfforts: [...GENERIC_MODEL_REASONING_EFFORTS],
        capabilities: [],
        serviceTiers: []
      };
    })
    .filter((model): model is ProviderModel => model !== undefined);
  return {
    providerId: "openai-compatible",
    models,
    source: "provider_api",
    fetchedAt: new Date().toISOString()
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
