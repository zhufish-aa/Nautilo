import type { ProviderModel, ProviderModelCatalog } from "@agenthub/domain";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const LARGE_CONTEXT_WINDOW = 1_000_000;
const CAPABILITIES = ["thinking", "tool_use", "vision"];
/** Claude Code --effort levels (claude --help, CLI 2.x). */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;

function contextWindowFor(modelId: string): number {
  // Mythos-class models ship a 1M-token window; the models API does not report
  // one, so the window stays an estimate until Anthropic exposes it.
  return /fable|mythos/i.test(modelId) ? LARGE_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

function model(id: string, displayName: string, description?: string, isDefault = false): ProviderModel {
  return {
    id,
    displayName,
    description,
    isDefault,
    contextWindow: contextWindowFor(id),
    capabilities: [...CAPABILITIES],
    reasoningEfforts: [...CLAUDE_EFFORT_LEVELS],
    // Claude Code 2.x defaults to high; without this the UI fallback
    // (reasoningEfforts[0]) silently pins fresh sessions to --effort low.
    defaultReasoningEffort: "high",
    serviceTiers: []
  };
}

function fallbackEntry(): ProviderModel {
  return model("default", "默认（跟随 Claude Code 配置）", "不向 CLI 传 --model，使用 Claude Code 当前配置的模型", true);
}

/**
 * Static alias catalog. Claude Code resolves aliases to the latest released
 * model of each family, so this never pins a versioned model ID. Used when no
 * Anthropic credential is available for live discovery.
 */
export function listClaudeModels(): ProviderModelCatalog {
  return {
    providerId: "claude-code",
    defaultModel: "default",
    source: "provider_cli",
    fetchedAt: new Date().toISOString(),
    models: [
      fallbackEntry(),
      model("sonnet", "Claude Sonnet（最新别名）", "由 CLI 解析到最新的 Sonnet 模型，速度与能力均衡"),
      model("opus", "Claude Opus（最新别名）", "由 CLI 解析到最新的 Opus 模型，推理能力强"),
      model("haiku", "Claude Haiku（最新别名）", "由 CLI 解析到最新的 Haiku 模型，响应最快"),
      model("opusplan", "Opus Plan 模式", "计划阶段使用 Opus，执行阶段使用 Sonnet")
    ]
  };
}

interface AnthropicModelEntry {
  id?: unknown;
  display_name?: unknown;
  created_at?: unknown;
  type?: unknown;
}

type FetchModelsResult = { ok: true; entries: AnthropicModelEntry[] } | { ok: false; reason: string };

/** GET /v1/models against the configured Anthropic endpoint; reports why it failed. */
async function fetchAnthropicModels(env: Record<string, string | undefined>): Promise<FetchModelsResult> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (!apiKey && !authToken) return { ok: false, reason: "missing_credential" };
  const baseUrl = (env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, reason: `invalid_base_url:${baseUrl}` };
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (apiKey) headers["x-api-key"] = apiKey;
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  const entries: AnthropicModelEntry[] = [];
  let after: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const url = new URL(`${baseUrl}/v1/models`);
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after_id", after);
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    } catch (error) {
      return { ok: false, reason: `network:${error instanceof Error ? error.message : String(error)}` };
    }
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    const body = await response.json().catch(() => undefined) as { data?: AnthropicModelEntry[]; has_more?: boolean; last_id?: string } | undefined;
    if (!body || !Array.isArray(body.data)) return { ok: false, reason: "invalid_response" };
    entries.push(...body.data);
    if (!body.has_more || typeof body.last_id !== "string" || !body.last_id) break;
    after = body.last_id;
  }
  return { ok: true, entries };
}

function discoveryWarning(reason: string, env: Record<string, string | undefined>): string {
  const baseUrl = (env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
  if (reason === "missing_credential") {
    return "未找到 Anthropic 凭证（ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN），无法在线拉取模型列表，已回退到内置别名目录。";
  }
  if (reason.startsWith("invalid_base_url:")) {
    return `ANTHROPIC_BASE_URL 不是合法的 http(s) 地址（${reason.slice("invalid_base_url:".length)}），已回退到内置别名目录。`;
  }
  if (reason.startsWith("http_")) {
    return `模型列表接口 ${baseUrl}/v1/models 返回 HTTP ${reason.slice("http_".length)}（凭证或中转站不支持该接口），已回退到内置别名目录。`;
  }
  if (reason === "invalid_response") {
    return `模型列表接口 ${baseUrl}/v1/models 返回了无法解析的内容，已回退到内置别名目录。`;
  }
  if (reason.startsWith("network:")) {
    return `请求模型列表接口 ${baseUrl}/v1/models 失败：${reason.slice("network:".length)}，已回退到内置别名目录。`;
  }
  return `模型列表接口 ${baseUrl}/v1/models 未返回任何模型，已回退到内置别名目录。`;
}

/**
 * Live model discovery through the Anthropic models API, so newly released
 * models show up without an AgentHub update. Falls back to the CLI alias
 * catalog when the instance has no API credential or the endpoint is down.
 */
export async function discoverClaudeModels(env?: Record<string, string | undefined>): Promise<ProviderModelCatalog> {
  const discoveryEnv = env ?? {};
  const result = await fetchAnthropicModels(discoveryEnv);
  if (result.ok && result.entries.length) {
    const models = result.entries
      .filter((entry) => (entry.type === undefined || entry.type === "model") && typeof entry.id === "string" && entry.id.trim().length > 0)
      .map((entry) => ({
        createdAt: typeof entry.created_at === "string" ? entry.created_at : "",
        model: model(
          entry.id as string,
          typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name : entry.id as string,
          typeof entry.created_at === "string" ? `发布于 ${entry.created_at.slice(0, 10)}` : undefined
        )
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((entry) => entry.model);
    return {
      providerId: "claude-code",
      defaultModel: "default",
      source: "provider_cli",
      fetchedAt: new Date().toISOString(),
      models: [fallbackEntry(), ...models]
    };
  }
  const reason = result.ok ? "empty_result" : result.reason;
  console.warn(`[agenthub] claude-code model discovery failed (${reason}); falling back to CLI alias catalog`);
  return { ...listClaudeModels(), warning: discoveryWarning(reason, discoveryEnv) };
}
