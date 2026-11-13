import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Documents, record, text, type Doc } from "./documents.js";
import { add, builtins, claude, codex, model, providerMap, type Candidate } from "./parsers.js";
import type { NativeLocation } from "./locations.js";

function merge(base: Doc, patch: Doc): Doc {
  for (const [k, v] of Object.entries(record(patch))) {
    if (["__proto__", "constructor", "prototype"].includes(k)) continue;
    base[k] = record(base[k]) === base[k] && record(v) === v ? merge(base[k], v) : v;
  }
  return base;
}
function ompCatalog(docs: Documents, root: string): { auth: Doc; cfg: Doc } {
  const auth: Doc = {}, providers: Doc = {}, file = join(root, "agent.db");
  if (existsSync(file)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: true }); db.exec("PRAGMA busy_timeout=200");
      for (const row of db.prepare("SELECT provider,data FROM auth_credentials WHERE credential_type='api_key' AND disabled_cause IS NULL LIMIT 128").all()) {
        const value = JSON.parse(String(row.data)); if (typeof value.key === "string") auth[String(row.provider)] = { type: "api_key", key: value.key };
      }
      docs.reports.push({ harness: "omp", path: file, status: "read" });
    } catch { docs.reports.push({ harness: "omp", path: file, status: "error", error: "CONFIG_UNREADABLE" }); } finally { db?.close(); }
  }
  if (existsSync(join(root, "models.db"))) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(root, "models.db"), { readOnly: true }); db.exec("PRAGMA busy_timeout=200");
      for (const id of Object.keys(auth)) {
        const row = db.prepare("SELECT models FROM model_cache WHERE provider_id=? LIMIT 1").get(id);
        if (typeof row?.models === "string" && row.models.length < 4 * 1024 * 1024) {
          const first = JSON.parse(row.models)?.[0]; if (first) providers[id] = { baseUrl: first.baseUrl, api: first.api, models: [] };
        }
      }
    } catch { /* Cache is optional; custom models and known native endpoints still work. */ } finally { db?.close(); }
  }
  return { auth, cfg: { providers } };
}
export function discover(docs: Documents, locations: NativeLocation[], home: string): Candidate[] {
  const out: Candidate[] = [], refs = record(docs.read("deepseek", join(docs.env.DSH_HOME || join(home, ".dsh"), ".credentials.yaml")).refs);
  for (const { harness, root, config } of locations) {
    if (out.length >= 256) break;
    if (harness === "codex") codex(docs, root, out, join);
    else if (["claude", "claude-code"].includes(harness)) claude(docs, root, out, join);
    else if (["pi", "omp"].includes(harness)) {
      let cfg: Doc = { providers: {} }, auth = docs.read(harness, join(root, "auth.json"));
      if (harness === "omp") { const native = ompCatalog(docs, root); cfg = merge(cfg, native.cfg); auth = merge(auth, native.auth); }
      for (const [id, a] of Object.entries(auth)) if (["api", "api_key"].includes(record(a).type) && builtins[id] && !cfg.providers[id]) cfg.providers[id] = {};
      for (const file of ["models.json", "models.yml", "models.yaml"]) cfg = merge(cfg, docs.read(harness, join(root, file)));
      const settings = docs.read(harness, join(root, harness === "omp" ? "config.yml" : "settings.json"));
      const selected = typeof settings.modelRoles?.default === "string" ? settings.modelRoles.default.split(/\/(.*)/s) : [settings.defaultProvider, settings.defaultModel];
      if (selected[0] && selected[1] && cfg.providers[selected[0]] && !modelsPresent(cfg.providers[selected[0]].models)) cfg.providers[selected[0]].models = [{ id: selected[1] }];
      const path = ["models.json", "models.yml", "models.yaml", "auth.json", "agent.db"].map(p => join(root, p)).find(existsSync) ?? join(root, "models.json");
      providerMap(docs, harness, path, cfg, auth, {}, out);
    } else if (harness === "opencode") {
      const auth = docs.read(harness, join(docs.env.XDG_DATA_HOME || join(home, ".local/share"), "opencode/auth.json"));
      let cfg: Doc = {}, source = join(root, "opencode.json");
      for (const path of config ? [config] : [join(root, "opencode.json"), join(root, "opencode.jsonc")]) {
        const item = docs.read(harness, path); if (Object.keys(item).length) { source = path; cfg = merge(cfg, item); }
      }
      const providers = { ...record(cfg.provider) };
      for (const [id, value] of Object.entries(auth)) if (record(value).type === "api" && builtins[id]) providers[id] ??= {};
      for (const selected of [cfg.model, cfg.small_model]) {
        if (typeof selected !== "string" || !selected.includes("/")) continue;
        const at = selected.indexOf("/"), provider = selected.slice(0, at), id = selected.slice(at + 1), p = providers[provider];
        if (p) { p.models = record(p.models); p.models[id] ??= { name: id }; }
      }
      cfg.provider = providers;
      if (!existsSync(source)) source = join(docs.env.XDG_DATA_HOME || join(home, ".local/share"), "opencode/auth.json");
      providerMap(docs, harness, source, cfg, auth, {}, out);
    } else if (["kimi", "kimi-code"].includes(harness)) {
      const path = join(root, "config.toml"), cfg = docs.read(harness, path);
      for (const [id, raw] of Object.entries(record(cfg.providers))) {
        const p = record(raw), configured = Object.values(record(cfg.models)).flatMap(raw => { const m = record(raw); const result = m.provider === id ? model(m) : undefined; return result ? [result] : []; });
        add(out, docs, "kimi-code", path, id, p.type === "anthropic" ? "anthropic" : "chat", p.base_url ?? "", p.api_key ?? (p.api_key_env ? `{env:${p.api_key_env}}` : undefined), {}, configured);
      }
    } else if (harness === "trae") {
      for (const path of config ? [config] : ["trae_config.yaml", "trae_config.yml", "trae_config.json"].map(p => join(root, p))) {
        const cfg = docs.read(harness, path);
        for (const [id, raw] of Object.entries(record(cfg.model_providers))) {
          const p = record(raw); if (!["openai", "anthropic"].includes(p.provider)) continue;
          const configured = Object.values(record(cfg.models)).flatMap(raw => { const m = record(raw), result = m.model_provider === id ? model(m) : undefined; return result ? [result] : []; });
          add(out, docs, harness, path, id, p.provider === "openai" ? "chat" : "anthropic", p.base_url ?? builtins[p.provider][1], p.api_key, {}, configured);
        }
      }
    } else if (["command", "command-code"].includes(harness)) {
      const path = join(root, "config.json"), cfg = docs.read(harness, path), auth = docs.read(harness, join(root, "auth.json")), m = model(cfg.model);
      if (typeof auth.apiKey === "string") add(out, docs, harness, path, "Command Code", "responses", text(cfg, "baseUrl", "baseURL") ?? "https://api.commandcode.ai/provider/v1", auth.apiKey, {}, m ? [m] : []);
    } else if (harness === "deepseek") {
      let cfg: Doc = { providers: {} }, source = join(root, "cordis.yml");
      for (const path of [join(root, "cordis.yml"), join(root, "cordis.patch.yml")]) {
        const entries = docs.read(harness, path); if (!Array.isArray(entries)) continue;
        for (const raw of entries) { const entry = record(raw); if (entry.id === "llm-pi-ai" || String(entry.name).includes("dsh-llm-pi-ai")) { cfg = merge(cfg, record(entry.config)); source = path; } }
      }
      providerMap(docs, harness, source, cfg, {}, refs, out);
    }
  }
  return out.slice(0, 256);
}
const modelsPresent = (value: unknown): boolean => Array.isArray(value) ? value.length > 0 : Object.keys(record(value)).length > 0;
