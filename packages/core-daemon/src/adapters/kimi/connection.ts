import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "smol-toml";
import { inheritNativeResources } from "@agenthub/provider-sdk";
import type { AdapterStartRequest } from "../types.js";

/** Kimi owns its native provider config; keys stay in the invocation env. */
export function prepareKimiConnection(request: AdapterStartRequest): Record<string, string | undefined> {
  const env = { ...request.env };
  const options = request.instance.providerOptions;
  if (!options?.runtimeConnectionId) return env;
  if (!env.NAUTILO_CONNECTION_DIRECTORY) throw new Error("API connection directory is missing");
  const directory = join(env.NAUTILO_CONNECTION_DIRECTORY, "kimi-code");
  const native = env.KIMI_CODE_HOME || process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  inheritNativeResources(native, directory, ["mcp.json", "skills", "hooks", "agents", "plugins", "rules"]);
  const nativeMcp = join(native, "mcp.json");
  writeFileSync(join(directory, "mcp.json"), existsSync(nativeMcp) ? readFileSync(nativeMcp) : "{}", { mode: 0o600 });
  const models = (request.instance.models ?? []).filter(model => model.enabled !== false);
  const type = options.apiType === "anthropic-messages" ? "anthropic" : options.apiType === "openai-responses" ? "openai_responses" : "openai";
  let config = `default_model = ${JSON.stringify(models[0]?.id ?? "")}\n\n[providers.nautilo]\ntype = ${JSON.stringify(type)}\nbase_url = ${JSON.stringify(options.baseUrl)}\napi_key_env = "NAUTILO_CONNECTION_API_KEY"\n`;
  for (const model of models) config += `\n[models.${JSON.stringify(model.id)}]\nprovider = "nautilo"\nmodel = ${JSON.stringify(model.id)}\nmax_context_size = ${model.contextWindow ?? 128_000}\n${model.reasoningEfforts.length ? 'capabilities = ["thinking"]\n' : ""}`;
  const nativeFile = join(native, "config.toml");
  const inherited = existsSync(nativeFile) ? parse(readFileSync(nativeFile, "utf8")) : {};
  for (const key of ["providers", "models", "default_model"]) delete inherited[key];
  writeFileSync(join(directory, "config.toml"), stringify({ ...inherited, ...parse(config) }), { mode: 0o600 });
  if (request.mcpServers?.length) {
    const file = join(directory, "mcp.json");
    const document = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    if (document.mcpServers === undefined) document.mcpServers = {};
    if (!document.mcpServers || typeof document.mcpServers !== "object" || Array.isArray(document.mcpServers)) throw new Error("Kimi mcpServers must be an object");
    for (const { name, transport, ...spec } of request.mcpServers) {
      const entry = { ...document.mcpServers[name] };
      for (const key of ["command", "args", "env", "cwd", "url", "headers", "type", "transport"]) delete entry[key];
      document.mcpServers[name] = { ...entry, ...spec, ...(transport === "http" ? {} : { type: transport }) };
    }
    writeFileSync(file, JSON.stringify(document, null, 2), { mode: 0o600 });
  }
  return { ...env, KIMI_CODE_HOME: directory };
}
