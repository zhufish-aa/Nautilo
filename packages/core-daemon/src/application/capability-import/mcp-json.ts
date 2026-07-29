import type { McpServerConfig } from "@agenthub/domain";
import type { McpCandidate } from "@agenthub/schemas";

/** `${env:FOO}`, `${FOO}` and `$FOO` all mean "read FOO from the environment". */
const PLACEHOLDER = /^\$(?:\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;

const BEARER_PLACEHOLDER = /^Bearer\s+\$(?:\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/i;

/** Key names whose literal values are worth flagging before they land in SQLite. */
const SECRET_KEY = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** Well-known credential prefixes, so we can warn even when the key name is bland. */
const SECRET_VALUE = /^(gh[pousr]_|github_pat_|sk-|sk_live_|xox[baprs]-|AIza|ya29\.|glpat-|npm_)/;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extracts the env var name from a `${...}` / `$NAME` placeholder. */
function placeholderEnvName(value: string): string | undefined {
  const match = PLACEHOLDER.exec(value.trim());
  if (!match) return undefined;
  return match[1] ?? match[2];
}

function looksLikeSecret(key: string, value: string): boolean {
  if (!value.trim()) return false;
  if (placeholderEnvName(value)) return false;
  return SECRET_VALUE.test(value) || (SECRET_KEY.test(key) && value.length >= 8);
}

/** A server entry must at least say how to reach the server. */
function looksLikeServer(value: unknown): value is Json {
  if (!isObject(value)) return false;
  return ["command", "url", "serverUrl", "endpoint", "type", "transport", "args"].some((key) => key in value);
}

function readString(source: Json, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readStringArray(value: unknown, warnings: string[], label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${label} 不是数组，已忽略`);
    return [];
  }
  return value.map((item) => (typeof item === "string" ? item : String(item))).filter((item) => item.length > 0);
}

/**
 * Reads a `Record<string, string>`-ish block, coercing stray numbers/booleans
 * instead of dropping the whole entry.
 */
function readRecord(value: unknown, warnings: string[], label: string): Record<string, string> {
  if (!isObject(value)) {
    if (value !== undefined && value !== null) warnings.push(`${label} 不是对象，已忽略`);
    return {};
  }
  const record: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      record[key] = raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      record[key] = String(raw);
      warnings.push(`${label}.${key} 不是字符串，已转换为 "${String(raw)}"`);
    } else {
      warnings.push(`${label}.${key} 类型不支持，已忽略`);
    }
  }
  return record;
}

function resolveTransport(source: Json, warnings: string[]): "stdio" | "http" | undefined {
  const declared = readString(source, "type", "transport")?.toLowerCase();
  if (declared) {
    if (declared === "stdio" || declared === "local") return "stdio";
    if (declared === "http" || declared === "streamable-http" || declared === "streamablehttp" || declared === "https") return "http";
    if (declared === "sse") {
      warnings.push("SSE 传输已按 HTTP 处理");
      return "http";
    }
    warnings.push(`未知的传输类型 "${declared}"，已按字段推断`);
  }
  if (readString(source, "command")) return "stdio";
  if (readString(source, "url", "serverUrl", "endpoint")) return "http";
  return undefined;
}

/**
 * Moves `${VAR}` placeholders out of literal env values and into
 * `envPassthrough`, which is what `capabilityToMcpServer` resolves at run time.
 * Without this the imported server would receive the literal `${VAR}` string.
 */
function splitEnv(
  raw: Record<string, string>,
  warnings: string[]
): { env: Record<string, string>; envPassthrough: string[] } {
  const env: Record<string, string> = {};
  const envPassthrough: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const envName = placeholderEnvName(value);
    if (envName === key) {
      envPassthrough.push(key);
      continue;
    }
    if (envName) {
      // McpServerConfig can only forward a variable under its own name, so a
      // cross-name reference degrades to same-name passthrough plus a warning.
      warnings.push(`env.${key} 原本引用 \${${envName}}，已改为透传同名变量 ${key}`);
      envPassthrough.push(key);
      continue;
    }
    if (value.includes("${")) {
      warnings.push(`env.${key} 含无法解析的占位符 "${value}"，请手动确认`);
    } else if (looksLikeSecret(key, value)) {
      warnings.push(`env.${key} 是明文密钥，建议改用环境变量透传`);
    }
    env[key] = value;
  }
  return { env, envPassthrough };
}

/** Same idea as `splitEnv`, for HTTP headers plus the Bearer-token shortcut. */
function splitHeaders(
  raw: Record<string, string>,
  warnings: string[]
): { headers: Record<string, string>; envHeaders: Record<string, string>; bearerTokenEnvVar?: string } {
  const headers: Record<string, string> = {};
  const envHeaders: Record<string, string> = {};
  let bearerTokenEnvVar: string | undefined;
  for (const [header, value] of Object.entries(raw)) {
    const bearer = BEARER_PLACEHOLDER.exec(value.trim());
    if (header.toLowerCase() === "authorization" && bearer) {
      bearerTokenEnvVar = bearer[1] ?? bearer[2];
      continue;
    }
    const envName = placeholderEnvName(value);
    if (envName) {
      envHeaders[header] = envName;
      continue;
    }
    if (value.includes("${")) {
      warnings.push(`请求头 ${header} 含无法解析的占位符 "${value}"，请手动确认`);
    } else if (looksLikeSecret(header, value)) {
      warnings.push(`请求头 ${header} 含明文密钥，建议改用环境变量`);
    }
    headers[header] = value;
  }
  return { headers, envHeaders, bearerTokenEnvVar };
}

/** Turns one entry of an `mcpServers` map into a preview candidate. */
export function toMcpCandidate(name: string, source: Json, origin?: string): McpCandidate | undefined {
  const warnings: string[] = [];
  const transport = resolveTransport(source, warnings);
  if (!transport) return undefined;

  let mcp: McpServerConfig;
  if (transport === "stdio") {
    const command = readString(source, "command");
    if (!command) return undefined;
    const args = readStringArray(source.args, warnings, "args");
    const { env, envPassthrough } = splitEnv(readRecord(source.env, warnings, "env"), warnings);
    const cwd = readString(source, "cwd", "workingDirectory");
    mcp = {
      transport: "stdio",
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(envPassthrough.length > 0 ? { envPassthrough: [...new Set(envPassthrough)] } : {}),
      ...(cwd ? { cwd } : {})
    };
  } else {
    const url = readString(source, "url", "serverUrl", "endpoint");
    if (!url) return undefined;
    const { headers, envHeaders, bearerTokenEnvVar } = splitHeaders(readRecord(source.headers, warnings, "headers"), warnings);
    mcp = {
      transport: "http",
      url,
      ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(Object.keys(envHeaders).length > 0 ? { envHeaders } : {})
    };
  }

  const disabled = source.disabled === true || source.enabled === false;
  if (disabled) warnings.push("来源中该服务为停用状态，导入后保持停用");

  return {
    name: name.trim() || "mcp-server",
    description: readString(source, "description") ?? "",
    tags: readStringArray(source.tags, [], "tags"),
    mcp,
    enabled: !disabled,
    warnings,
    ...(origin ? { origin } : {})
  };
}

interface ServerMap {
  map: Json;
  /** Set for per-project blocks so the preview can say where a server came from. */
  scope?: string;
}

/**
 * Collects every container that holds a server map. Config files in the wild
 * nest it differently (`mcpServers`, VS Code's `servers`, `mcp.servers`), users
 * often paste just the inner map, and `~/.claude.json` additionally keeps a
 * per-project block under `projects["<path>"].mcpServers`.
 */
function findServerMaps(root: Json): ServerMap[] {
  const found: ServerMap[] = [];
  for (const candidate of [root.mcpServers, root.servers]) {
    if (isObject(candidate)) found.push({ map: candidate });
  }
  if (isObject(root.mcp)) {
    for (const candidate of [root.mcp.servers, root.mcp.mcpServers]) {
      if (isObject(candidate)) found.push({ map: candidate });
    }
  }
  if (isObject(root.projects)) {
    for (const [projectPath, project] of Object.entries(root.projects)) {
      if (isObject(project) && isObject(project.mcpServers)) {
        found.push({ map: project.mcpServers, scope: projectPath });
      }
    }
  }
  if (found.length > 0) return found;
  // A bare map: every value must look like a server, otherwise we would happily
  // "find" servers inside an unrelated settings file.
  const entries = Object.entries(root);
  if (entries.length > 0 && entries.every(([, value]) => looksLikeServer(value))) return [{ map: root }];
  return [];
}

/**
 * Parses any of the common MCP config shapes into preview candidates. Unknown
 * sibling keys (`~/.claude.json` is full of them) are ignored rather than fatal.
 */
export function parseMcpConfigJson(text: string, origin?: string): { servers: McpCandidate[]; errors: string[] } {
  const trimmed = text.trim();
  if (!trimmed) return { servers: [], errors: [] };

  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch (error) {
    return { servers: [], errors: [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`] };
  }

  // An array of named servers, e.g. an export from a registry.
  if (Array.isArray(root)) {
    const servers: McpCandidate[] = [];
    const errors: string[] = [];
    root.forEach((entry, index) => {
      if (!isObject(entry)) return;
      const name = readString(entry, "name") ?? `server-${index + 1}`;
      const candidate = toMcpCandidate(name, entry, origin);
      if (candidate) servers.push(candidate);
      else errors.push(`第 ${index + 1} 项缺少 command 或 url，已跳过`);
    });
    return { servers, errors };
  }

  if (!isObject(root)) return { servers: [], errors: ["无法识别的 JSON 结构"] };

  const maps = findServerMaps(root);
  if (maps.length === 0) {
    // Possibly a single server object pasted on its own.
    if (looksLikeServer(root)) {
      const candidate = toMcpCandidate(readString(root, "name") ?? "mcp-server", root, origin);
      if (candidate) return { servers: [candidate], errors: [] };
    }
    return { servers: [], errors: ["未找到 mcpServers 配置"] };
  }

  const servers: McpCandidate[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const { map, scope } of maps) {
    for (const [name, value] of Object.entries(map)) {
      if (!isObject(value)) continue;
      const candidate = toMcpCandidate(name, value, scope ? `${origin ?? ""} · ${scope}`.trim() : origin);
      if (!candidate) {
        errors.push(`"${name}" 缺少 command 或 url，已跳过`);
        continue;
      }
      // The same server usually appears in both the global and project blocks.
      const key = candidate.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      servers.push(candidate);
    }
  }
  return { servers, errors };
}
