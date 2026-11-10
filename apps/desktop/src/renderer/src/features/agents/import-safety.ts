import type { McpServerConfig, ProviderCapability } from "@agenthub/domain";

const SECRET_NAME =
  /token|secret|password|passwd|credential|authorization|api[_-]?key|cookie/i;
const SECRET_VALUE =
  /^(?:Bearer\s+|sk-|gh[pousr]_|github_pat_|xox[baprs]-|AIza|ya29\.|glpat-|npm_)/i;
const MASK = "••••••••";
export function isSensitiveValue(name: string, value: string): boolean {
  return !!value && (SECRET_NAME.test(name) || SECRET_VALUE.test(value));
}
export function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = MASK;
    if (url.password) url.password = MASK;
    for (const key of [...url.searchParams.keys()])
      if (SECRET_NAME.test(key)) url.searchParams.set(key, MASK);
    return url.toString();
  } catch {
    return value;
  }
}
export function redactArguments(values: string[]): string[] {
  let redactNext = false;
  return values.map((value) => {
    if (redactNext) {
      redactNext = false;
      return MASK;
    }
    const split = value.indexOf("=");
    if (split > 0 && SECRET_NAME.test(value.slice(0, split)))
      return `${value.slice(0, split + 1)}${MASK}`;
    if (value.startsWith("-") && SECRET_NAME.test(value)) {
      redactNext = true;
      return value;
    }
    return SECRET_VALUE.test(value)
      ? MASK
      : /^https?:\/\//i.test(value)
        ? safeUrl(value)
        : value;
  });
}
/** Display-only masking. The original object is never mutated or sent through another parser. */
export function redactConfig(value: unknown, name = ""): unknown {
  if (typeof value === "string")
    return isSensitiveValue(name, value)
      ? MASK
      : /^https?:\/\//i.test(value)
        ? safeUrl(value)
        : value;
  if (Array.isArray(value))
    return name === "args" && value.every((item) => typeof item === "string")
      ? redactArguments(value as string[])
      : value.map((item) => redactConfig(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        (name === "env" || name === "headers") &&
        typeof item === "string" &&
        item
          ? MASK
          : redactConfig(item, key),
      ]),
    );
  return value;
}
export function maskedJson(text: string): string {
  if (!text.trim()) return "";
  try {
    return JSON.stringify(redactConfig(JSON.parse(text)), null, 2);
  } catch {
    return "••••••••";
  } // Never echo malformed input fragments containing a secret.
}
export function safeMcpSummary(mcp: McpServerConfig): string {
  return mcp.transport === "http"
    ? safeUrl(mcp.url ?? "")
    : [mcp.command, ...redactArguments(mcp.args ?? [])]
        .filter(Boolean)
        .join(" ");
}
/** Import is configuration-only. A separate explicit toggle activates an MCP. */
export function prepareImportedCapability(
  item: ProviderCapability,
): ProviderCapability {
  return item.kind === "mcp" ? { ...item, enabled: false } : item;
}
/** Async parse results are usable only for the exact source snapshot shown now. */
export function isCurrentPreview(
  source: string | undefined,
  text: string,
  acceptedKey: string | undefined,
): boolean {
  return !source || acceptedKey === `${source}\0${text}`;
}
