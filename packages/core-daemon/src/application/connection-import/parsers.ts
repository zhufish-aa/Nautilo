import { randomUUID } from "node:crypto";
import type { InstanceModelConfig } from "@agenthub/domain";
import type { NativeConnectionCandidate } from "@agenthub/schemas";
import { validateModelEndpoint } from "../../adapters/model-config.js";
import { Documents, record, text, type Doc } from "./documents.js";

export interface Candidate { public: NativeConnectionCandidate; secret?: string; }
export function protocol(api: string): NativeConnectionCandidate["protocol"] | undefined {
  if (["responses", "openai-responses"].includes(api)) return "responses";
  if (["chat", "openai-completions", "openai-chat-completions", "openai-compatible"].includes(api)) return "chat";
  if (["anthropic", "anthropic-messages"].includes(api)) return "anthropic";
}
export const builtins: Record<string, [string, string]> = {
  openai: ["responses", "https://api.openai.com/v1"], anthropic: ["anthropic", "https://api.anthropic.com"],
  deepseek: ["chat", "https://api.deepseek.com/v1"], "kimi-coding": ["anthropic", "https://api.kimi.com/coding"],
  "kimi-code": ["anthropic", "https://api.kimi.com/coding"], "opencode-go": ["chat", "https://opencode.ai/inference/go/v1"],
};
export function model(raw: unknown, fallback = ""): InstanceModelConfig | undefined {
  const doc = record(raw), id = (typeof raw === "string" ? raw : text(doc, "id", "model") ?? fallback).trim();
  if (!id || id.length > 512) return;
  const context = doc.contextWindow ?? doc.limit?.context, input = doc.input ?? doc.modalities?.input;
  const efforts: string[] = Array.isArray(doc.reasoningEfforts) ? doc.reasoningEfforts.map((v: unknown) => typeof v === "string" ? v : record(v).key).filter((v: unknown): v is string => typeof v === "string" && !!v).slice(0, 32) : [];
  const pricing = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].flatMap(key => { const value = doc.pricing?.[key] ?? doc.cost?.[key]; return typeof value === "number" && Number.isFinite(value) && value >= 0 ? [[key, value]] : []; }));
  return { id, displayName: text(doc, "name", "displayName") ?? id, enabled: true, reasoningEfforts: efforts,
    ...(efforts.includes(doc.defaultReasoningEffort) ? { defaultReasoningEffort: doc.defaultReasoningEffort } : {}),
    ...(Object.keys(pricing).length ? { pricing } : {}),
    ...(Number.isSafeInteger(context) && context > 0 ? { contextWindow: context } : {}),
    ...(Array.isArray(input) ? { inputModalities: input.includes("image") ? ["text", "image"] : ["text"] } : {}) };
}
export const models = (raw: unknown): InstanceModelConfig[] => (Array.isArray(raw) ? raw.map(m => model(m)) : Object.entries(record(raw)).map(([id, m]) => model(m, id))).filter((m): m is InstanceModelConfig => !!m).slice(0, 500);
export function add(out: Candidate[], docs: Documents, harness: string, path: string, name: string, api: string, url: string, key: unknown, refs: Doc, configured: InstanceModelConfig[]): void {
  const wire = protocol(api); if (!wire) return;
  let baseUrl: string;
  try { baseUrl = validateModelEndpoint(url.trim().replace(/\/+$/, "")); } catch { return; }
  if (wire === "anthropic") baseUrl = baseUrl.replace(/\/+$/, "").replace(/\/messages$/, "").replace(/\/v1$/, "");
  const secret = docs.key(key, refs, path);
  out.push({ secret, public: { id: randomUUID(), name: name.slice(0, 180), protocol: wire, baseUrl, models: configured, hasCredential: !!secret,
    sources: [{ harness, path }], warnings: [...(!secret ? ["CREDENTIAL_MISSING"] : []), ...(!configured.length ? ["MODELS_MISSING"] : [])] } });
}
export function providerMap(docs: Documents, harness: string, path: string, cfg: Doc, auth: Doc, refs: Doc, out: Candidate[]): void {
  for (const [id, raw] of Object.entries(record(cfg.providers ?? cfg.provider))) {
    const p = record(raw), options = p.options ? record(p.options) : p, defaults = builtins[id];
    const api = text(p, "api") ?? (p.npm === "@ai-sdk/openai" ? "responses" : p.npm === "@ai-sdk/anthropic" ? "anthropic" : p.npm === "@ai-sdk/openai-compatible" ? "chat" : defaults?.[0] ?? "chat");
    const url = text(options, "baseURL", "baseUrl", "base_url") ?? text(p, "baseURL", "baseUrl", "base_url") ?? defaults?.[1] ?? "";
    const key = options.apiKey ?? (p.apiKeyEnv ? `{env:${p.apiKeyEnv}}` : ["api", "api_key"].includes(auth[id]?.type) ? auth[id].key : undefined);
    const groups = new Map<string, InstanceModelConfig[]>();
    if (Array.isArray(p.models)) for (const raw of p.models) {
      const m = model(raw); if (!m) continue;
      const r = record(raw), key = JSON.stringify([text(r, "api") ?? api, text(r, "baseUrl", "baseURL") ?? url]);
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    if (!groups.size) groups.set(JSON.stringify([api, url]), models(p.models));
    for (const [group, configured] of groups) { const [wire, endpoint] = JSON.parse(group); add(out, docs, harness, path, text(p, "displayName", "name") ?? id, wire, endpoint, key, refs, configured); }
  }
}
export function codex(docs: Documents, root: string, out: Candidate[], join: (...parts: string[]) => string): void {
  const path = join(root, "config.toml"), cfg = docs.read("codex", path), auth = docs.read("codex", join(root, "auth.json"));
  const providers = { ...record(cfg.model_providers) };
  if (!providers.openai && typeof auth.OPENAI_API_KEY === "string") providers.openai = { base_url: builtins.openai[1], wire_api: "responses" };
  for (const [id, raw] of Object.entries(providers)) {
    const p = record(raw), selected: InstanceModelConfig[] = [];
    for (const profile of [cfg, ...Object.values(record(cfg.profiles)).map(record)]) if ((profile.model_provider ?? cfg.model_provider ?? "openai") === id) { const m = model(profile.model); if (m) selected.push(m); }
    add(out, docs, "codex", path, text(p, "name") ?? id, p.wire_api ?? "responses", p.base_url ?? "", p.experimental_bearer_token ?? (p.env_key ? `{env:${p.env_key}}` : auth.OPENAI_API_KEY), {}, selected);
  }
}
export function claude(docs: Documents, root: string, out: Candidate[], join: (...parts: string[]) => string): void {
  const cfg = docs.read("claude-code", join(root, "settings.json")), local = docs.read("claude-code", join(root, "settings.local.json"));
  const env = { ...record(cfg.env), ...record(local.env) }, get = (key: string): string | undefined => text(env, key) ?? docs.env[key];
  if (!get("ANTHROPIC_API_KEY") && !get("ANTHROPIC_AUTH_TOKEN") && !get("ANTHROPIC_BASE_URL")) return;
  const configured = ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"].flatMap(key => { const m = model(get(key)); return m ? [m] : []; });
  if (!configured.length) { const m = model(local.model ?? cfg.model); if (m) configured.push(m); }
  add(out, docs, "claude-code", join(root, "settings.json"), "Claude Code", "anthropic", get("ANTHROPIC_BASE_URL") ?? builtins.anthropic[1], get("ANTHROPIC_API_KEY") ?? get("ANTHROPIC_AUTH_TOKEN"), {}, configured);
}
