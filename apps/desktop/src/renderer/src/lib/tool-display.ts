import type { ToolFileDiff } from "@agenthub/event-protocol";

type ToolStatus = "running" | "done" | "failed";
type Locale = "zh-CN" | "en-US";

const PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "filepath",
  "target_path",
  "targetPath",
  "target_file",
  "targetFile",
  "filename",
  "file"
] as const;

const QUERY_KEYS = ["query", "pattern", "regex", "q", "search", "needle"] as const;
const GLOB_KEYS = ["glob", "pattern", "file_pattern", "filePattern", "include"] as const;

function decodeJsonStringFragment(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const escape = value[index + 1];
    if (escape === undefined) break;
    index += 1;
    if (escape === "n") decoded += "\n";
    else if (escape === "r") decoded += "\r";
    else if (escape === "t") decoded += "\t";
    else if (escape === "b") decoded += "\b";
    else if (escape === "f") decoded += "\f";
    else if (escape === "u") {
      const code = value.slice(index + 1, index + 5);
      if (!/^[0-9a-f]{4}$/i.test(code)) break;
      decoded += String.fromCharCode(Number.parseInt(code, 16));
      index += 4;
    } else decoded += escape;
  }
  return decoded;
}

function escapedKey(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function partialString(input: string, key: string, allowTruncated = false): { value: string; truncated: boolean } | undefined {
  const full = input.match(new RegExp(`"${escapedKey(key)}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (full) return { value: decodeJsonStringFragment(full[1]), truncated: false };
  if (!allowTruncated) return undefined;
  const prefix = new RegExp(`"${escapedKey(key)}"\\s*:\\s*"`).exec(input);
  if (!prefix) return undefined;
  return {
    value: decodeJsonStringFragment(input.slice(prefix.index + prefix[0].length)),
    truncated: true
  };
}

function parseInput(input: string | undefined): Record<string, unknown> | undefined {
  if (!input?.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const root = parsed as Record<string, unknown>;
    const nested = root.arguments ?? root.input;
    return typeof nested === "object" && nested !== null && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : root;
  } catch {
    const partial: Record<string, unknown> = {};
    for (const key of [...PATH_KEYS, ...QUERY_KEYS, ...GLOB_KEYS]) {
      const extracted = partialString(input, key);
      if (extracted) partial[key] = extracted.value;
    }
    for (const key of ["content", "text", "data"]) {
      const extracted = partialString(input, key, true);
      if (!extracted) continue;
      partial[key] = extracted.value;
      if (extracted.truncated) partial.__truncated = true;
      break;
    }
    return Object.keys(partial).length ? partial : undefined;
  }
}

function firstText(input: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstString(input: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function normalizedToolName(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function toolKind(toolName: string): "read" | "write" | "edit" | "grep" | "glob" | undefined {
  const normalized = normalizedToolName(toolName);
  if (normalized === "read" || normalized.startsWith("read_") || normalized.startsWith("reading_") || normalized.endsWith("_read") || normalized.endsWith("_read_file")) return "read";
  if (normalized === "write" || normalized.startsWith("write_") || normalized.startsWith("writing_") || normalized.endsWith("_write") || normalized.endsWith("_write_file")) return "write";
  if (normalized === "edit" || normalized.startsWith("edit_") || normalized.startsWith("editing_") || normalized.endsWith("_edit") || normalized.endsWith("_edit_file")) return "edit";
  if (normalized === "grep" || normalized.startsWith("grep_") || normalized.startsWith("searching_") || normalized.endsWith("_grep")) return "grep";
  if (normalized === "glob" || normalized.startsWith("glob_") || normalized.startsWith("finding_") || normalized.endsWith("_glob")) return "glob";
  return undefined;
}

function localizedAction(
  kind: NonNullable<ReturnType<typeof toolKind>>,
  status: ToolStatus,
  locale: Locale
): string {
  if (locale === "en-US") {
    const actions = {
      read: ["Reading", "Read", "Failed to read"],
      write: ["Writing", "Wrote", "Failed to write"],
      edit: ["Editing", "Edited", "Failed to edit"],
      grep: ["Searching", "Searched", "Search failed"],
      glob: ["Finding", "Found", "Find failed"]
    } as const;
    return actions[kind][status === "running" ? 0 : status === "done" ? 1 : 2];
  }
  const actions = {
    read: ["正在读取", "已读取", "读取失败"],
    write: ["正在写入", "已写入", "写入失败"],
    edit: ["正在编辑", "已编辑", "编辑失败"],
    grep: ["正在搜索", "已搜索", "搜索失败"],
    glob: ["正在查找", "已查找", "查找失败"]
  } as const;
  return actions[kind][status === "running" ? 0 : status === "done" ? 1 : 2];
}

export function toolActivityLabel(
  toolName: string,
  status: ToolStatus,
  input: string | undefined,
  locale: Locale
): string {
  const kind = toolKind(toolName);
  if (!kind) {
    if (locale === "zh-CN") return `${status === "running" ? "正在使用" : status === "done" ? "已使用" : "调用失败"} ${toolName}`;
    return `${status === "running" ? "Using" : status === "done" ? "Used" : "Failed"} ${toolName}`;
  }

  const parsed = parseInput(input);
  const path = firstText(parsed, PATH_KEYS);
  const subject = kind === "grep"
    ? firstText(parsed, QUERY_KEYS)
    : kind === "glob"
      ? firstText(parsed, GLOB_KEYS)
      : path;
  const location = (kind === "grep" || kind === "glob") && subject && path && subject !== path
    ? `${subject} · ${path}`
    : subject;
  const action = localizedAction(kind, status, locale);
  return location ? `${action} ${location}` : `${action} ${toolName}`;
}

export function toolInputFileDiff(toolName: string, input: string | undefined): ToolFileDiff | undefined {
  const kind = toolKind(toolName);
  if (kind !== "edit" && kind !== "write") return undefined;
  const parsed = parseInput(input);
  const path = firstText(parsed, PATH_KEYS);
  if (kind === "write") {
    const content = firstString(parsed, ["content", "text", "data"]);
    return content === undefined ? undefined : {
      operation: "write",
      path,
      before: "",
      after: content,
      ...(parsed?.__truncated === true ? { truncated: true } : {})
    };
  }
  const before = firstString(parsed, ["old_string", "oldString", "old_text", "oldText", "before"]);
  const after = firstString(parsed, ["new_string", "newString", "new_text", "newText", "after"]);
  if (before === undefined || after === undefined) return undefined;
  return {
    operation: "edit",
    path,
    before,
    after
  };
}
