import type { ToolFileDiff } from "@agenthub/event-protocol";
import type { TimelinePayload } from "./types";
import { isBrowserTool } from "./browser-display";

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

function parseInput(input: string | undefined, unwrap = true): Record<string, unknown> | undefined {
  if (!input?.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const root = parsed as Record<string, unknown>;
    const nested = root.arguments ?? root.input;
    return unwrap && typeof nested === "object" && nested !== null && !Array.isArray(nested)
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
  return toolName.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

export type ToolActivityKind = "command" | "read" | "write" | "edit" | "delete" | "search" | "mcp" | "skill" | "web" | "image" | "code" | "question" | "tool";

function mcpTool(name: string, input?: string): { server: string; tool: string } | undefined {
  const named = /^(?:functions\.)?(?:mcp(?:__|\.)(.+?)(?:__|[./:])(.+)|([\w.-]+)\/([\w.-]+))$/.exec(name);
  if (named) return { server: named[1] ?? named[3], tool: named[2] ?? named[4] };
  if (!normalizedToolName(name).startsWith("mcp")) return undefined;
  const parsed = parseInput(input, false);
  const server = firstText(parsed, ["serverName", "server", "server_name"]);
  return server ? { server, tool: firstText(parsed, ["toolName", "tool", "tool_name"]) ?? name } : undefined;
}

/** Classify the shared event vocabulary, including native names used by each CLI. */
export function toolActivityKind(name: string, input?: string): ToolActivityKind {
  const normalized = normalizedToolName(name);
  const parsed = parseInput(input);
  const path = firstText(parsed, PATH_KEYS);
  const command = firstText(parsed, ["command", "cmd", "command_line"]) ?? "";
  const fileKind = toolKind(name);
  if (/(?:^|_)(?:ask_user_question|askuserquestion|request_user_input)(?:_|$)/.test(normalized)) return "question";
  if (/(?:^|_)(?:load_skill|read_skill|use_skill|skill|skills)(?:_|$)/.test(normalized)
    || fileKind === "read" && /(?:^|[\\/])SKILL\.md$/i.test(path ?? "")
    || /(?:Get-Content|\bcat\b|\btype\b|\bsed\b|\bhead\b).*\bSKILL\.md\b/i.test(command)) return "skill";
  if (/(?:^|_)mcp(?:_|$)/.test(normalized) || normalized.startsWith("codex_apps_") || mcpTool(name)) return "mcp";
  if (/(?:^|_)(?:bash|pwsh|shell|shell_command|exec_command|run_command|execute_command|terminal|write_stdin)(?:_|$)/.test(normalized)) return "command";
  if (/(?:^|_)(?:read_image|view_image|image_gen|imagegen)(?:_|$)/.test(normalized)) return "image";
  if (/(?:^|_)(?:run_code|execute_code|python|node_repl)(?:_|$)/.test(normalized)) return "code";
  if (/(?:^|_)(?:web|web_search|web_fetch|fetch_url|browse)(?:_|$)/.test(normalized)) return "web";
  if (fileKind === "grep" || fileKind === "glob") return "search";
  if (fileKind) return fileKind;
  if (/(?:^|_)(?:str_replace|apply_patch|replace_in_file|edit_file)(?:_|$)/.test(normalized)) return "edit";
  if (/(?:^|_)(?:view_files|view_file|read_file|read_text_file|open_file)(?:_|$)/.test(normalized)) return "read";
  if (/(?:^|_)(?:create_file|write_file)(?:_|$)/.test(normalized)) return "write";
  if (/(?:^|_)(?:delete_file|remove_file)(?:_|$)/.test(normalized)) return "delete";
  if (/(?:^|_)(?:search|find|list_directory|list_dir|ls)(?:_|$)/.test(normalized)) return "search";
  return "tool";
}

export function codeExecutionInput(input: string | undefined): { code: string; description?: string; truncated: boolean } {
  const parsed = parseInput(input);
  const code = firstString(parsed, ["code"]);
  if (code !== undefined) return { code, description: firstText(parsed, ["description"]), truncated: false };
  const partial = input ? partialString(input, "code", true) : undefined;
  return { code: partial?.value ?? input ?? "", description: input ? partialString(input, "description")?.value : undefined, truncated: partial?.truncated ?? false };
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
  kind: NonNullable<ReturnType<typeof toolKind>> | "delete",
  status: ToolStatus,
  locale: Locale
): string {
  if (locale === "en-US") {
    const actions = {
      read: ["Reading", "Read", "Failed to read"],
      write: ["Writing", "Wrote", "Failed to write"],
      edit: ["Editing", "Edited", "Failed to edit"],
      delete: ["Deleting", "Deleted", "Failed to delete"],
      grep: ["Searching", "Searched", "Search failed"],
      glob: ["Finding", "Found", "Find failed"]
    } as const;
    return actions[kind][status === "running" ? 0 : status === "done" ? 1 : 2];
  }
  const actions = {
    read: ["正在读取", "已读取", "读取失败"],
    write: ["正在写入", "已写入", "写入失败"],
    edit: ["正在编辑", "已编辑", "编辑失败"],
    delete: ["正在删除", "已删除", "删除失败"],
    grep: ["正在搜索", "已搜索", "搜索失败"],
    glob: ["正在查找", "已查找", "查找失败"]
  } as const;
  return actions[kind][status === "running" ? 0 : status === "done" ? 1 : 2];
}

export function toolActivityLabel(
  toolName: string,
  status: ToolStatus,
  input: string | undefined,
  locale: Locale,
  omitFilePath = false
): string {
  if (toolActivityKind(toolName, input) === "question") {
    const actions = locale === "zh-CN" ? ["等待你的回答", "已提问", "提问未完成"] : ["Waiting for your answer", "Asked a question", "Question not completed"];
    return actions[status === "running" ? 0 : status === "done" ? 1 : 2];
  }
  const mcp = mcpTool(toolName, input);
  const activity = toolActivityKind(toolName, input);
  const parsed = parseInput(input);
  if (mcp) {
    const verb = locale === "zh-CN" ? { running: "正在调用", done: "调用了", failed: "调用失败" }[status]
      : { running: "Calling", done: "Called", failed: "Call failed" }[status];
    return verb + " " + mcp.server + " · " + mcp.tool;
  }
  if (activity === "web") {
    const verb = locale === "zh-CN" ? { running: "正在搜索网页", done: "搜索网页", failed: "网页搜索失败" }[status]
      : { running: "Searching the web", done: "Searched the web", failed: "Web search failed" }[status];
    const query = firstText(parsed, [...QUERY_KEYS, "url"]) ?? (!parsed && input && !/^\s*(?:\{|\[)/.test(input) ? input.trim() : undefined);
    return query ? verb + " · " + query : verb;
  }
  const kind = toolKind(toolName) ?? (activity === "search" ? "grep"
    : activity === "read" || activity === "edit" || activity === "write" || activity === "delete" ? activity : undefined);
  if (!kind) {
    if (locale === "zh-CN") return `${status === "running" ? "正在使用" : status === "done" ? "已使用" : "调用失败"} ${toolName}`;
    return `${status === "running" ? "Using" : status === "done" ? "Used" : "Failed"} ${toolName}`;
  }

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
  if (omitFilePath) return action;
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

export type ToolClusterStep = Extract<TimelinePayload, { kind: "tool_activity" | "command" | "file_change" }>;

export function isToolClusterStep(data: TimelinePayload | undefined): data is ToolClusterStep {
  return data?.kind === "tool_activity" || data?.kind === "command" || data?.kind === "file_change";
}

export function toolFilePath(input: string | undefined): string | undefined {
  return firstText(parseInput(input), PATH_KEYS);
}

export function toolCommand(input: string | undefined): string | undefined {
  return firstText(parseInput(input), ["command", "cmd", "command_line"]);
}

const clusterKinds = ["read", "edit", "write", "delete", "command", "browser", "web", "search", "agent", "mcp", "tool"] as const;
type ClusterKind = typeof clusterKinds[number];

const fileChangeKinds = { added: "write", modified: "edit", deleted: "delete" } as const;

export function formatToolClusterSummary(steps: readonly ToolClusterStep[], locale: Locale = "zh-CN") {
  const zh = locale === "zh-CN";
  const categories = new Map<ClusterKind, { count: number; paths: Set<string>; missingPaths: number; running: boolean }>();
  const servers = new Map<string, { name: string; count: number }>();
  const tools = new Set<string>();
  let running = 0;
  let failed = 0;
  let activeMcp: ReturnType<typeof mcpTool>;
  const add = (kind: ClusterKind, paths: readonly string[] = [], active = false): void => {
    const category = categories.get(kind) ?? { count: 0, paths: new Set<string>(), missingPaths: 0, running: false };
    category.count += Math.max(paths.length, 1);
    if (!paths.length) category.missingPaths++;
    category.running ||= active;
    for (const path of paths) category.paths.add(path);
    categories.set(kind, category);
  };
  for (const step of steps) {
    if (step.kind === "file_change") {
      for (const file of step.files) add(fileChangeKinds[file.changeType], [file.path]);
      if (!step.files.length) add("tool");
      continue;
    }
    const status = (step.kind === "tool_activity" ? step.subagent?.status : undefined) ?? step.status;
    const active = status === "running";
    if (active) running++;
    if (status === "failed") failed++;
    if (step.kind === "command") {
      add("command", [], active);
      continue;
    }
    const { toolName, input, fileDiff, subagent } = step;
    const mcp = mcpTool(toolName, input);
    const activity = toolActivityKind(toolName, input);
    if (subagent) add("agent", [], active);
    else if (isBrowserTool(toolName)) add("browser", [], active);
    else if (mcp) {
      add("mcp", [], active);
      const key = mcp.server.toLowerCase();
      const server = servers.get(key) ?? { name: mcp.server, count: 0 };
      server.count++;
      servers.set(key, server);
      if (active) activeMcp = mcp;
    } else if (activity === "command" || activity === "search" || activity === "web") add(activity, [], active);
    else {
      const kind = (fileDiff ? fileDiff.operation ?? "edit" : undefined) ??
        (activity === "read" || activity === "write" || activity === "edit" || activity === "delete" ? activity : "tool");
      if (kind === "tool") {
        tools.add(toolName);
        add(kind, [], active);
        continue;
      }
      const parsed = parseInput(input);
      const paths = parsed?.paths ?? parsed?.files ?? parsed?.filePaths;
      const path = fileDiff?.path ?? firstText(parsed, PATH_KEYS);
      add(kind, Array.isArray(paths) ? paths.filter((value): value is string => typeof value === "string" && Boolean(value.trim())) : path ? [path] : [], active);
    }
  }
  const fileLabels = {
    read: ["读取", "Read", "Reading"], edit: ["编辑", "Edited", "Editing"], write: ["创建", "Created", "Creating"],
    delete: ["删除", "Deleted", "Deleting"]
  } as const;
  const labels = {
    command: ["运行了", "正在运行命令", "条命令", "Ran", "Running", "command"],
    browser: ["操作了", "正在操作浏览器", "次浏览器", "Performed", "Performing", "browser action"],
    web: ["检索了", "正在检索网页", "次网页", "Ran", "Running", "web search"],
    search: ["搜索了", "正在搜索文件", "次文件", "Ran", "Running", "file search"],
    agent: ["调度了", "正在调度子 Agent", "个子 Agent", "Dispatched", "Dispatching", "subagent"]
  } as const;
  const sections = clusterKinds.flatMap(kind => {
    const category = categories.get(kind);
    if (!category) return [];
    const n = kind in fileLabels ? category.paths.size + category.missingPaths : category.count;
    const running = category.running;
    const plural = n === 1 ? "" : "s";
    let label: string;
    if (kind === "mcp") {
      const verb = zh ? (running ? "正在调用" : "调用了") : (running ? "Calling" : "Called");
      const names = [...servers.values()];
      const service = names[0]!;
      label = names.length === 1
        ? activeMcp ? verb + " " + service.name + " · " + activeMcp.tool + (n > 1 ? " (" + n + ")" : "")
          : verb + " " + service.name + " · " + n + (zh ? " 次" : " call" + plural)
        : names.length === 2
          ? verb + " " + names.map(item => item.name + " (" + item.count + ")").join(" · ")
          : verb + " " + names.length + (zh ? " 个 MCP 服务 · " : " MCP services · ") + n + (zh ? " 次" : " calls");
    } else if (kind === "tool") {
      const name = tools.size === 1 ? tools.values().next().value : undefined;
      label = zh ? (running ? "正在调用" : "调用了") + " " + n + " 次" + (name ? " " + name : "工具")
        : (running ? "Calling" : "Called") + (name ? " " + name : " tools") + " · " + n + " time" + plural;
    } else if (kind in fileLabels) {
      const [verb, past, present] = fileLabels[kind as keyof typeof fileLabels];
      label = zh ? (running ? "正在" : "") + verb + " " + n + " 个文件" : (running ? present : past) + " " + n + " file" + plural;
    } else {
      const [past, present, unit, enPast, enPresent, enUnit] = labels[kind as keyof typeof labels];
      label = zh ? running ? present + " · " + n : past + " " + n + " " + unit
        : (running ? enPresent : enPast) + " " + n + " " + enUnit + plural;
    }
    return [{ kind, operations: category.count, label }];
  });
  const overflow = sections.length > 3 ? sections.slice(2).reduce((total, section) => total + section.operations, 0) : 0;
  const label = sections.slice(0, overflow ? 2 : 3).map(section => section.label);
  if (overflow) label.push(zh ? "等 " + overflow + " 项操作" : "+" + overflow + " more operations");
  const kind = sections[0]?.kind ?? "tool";
  return { label: label.join(" · "), kind, running: running > 0, failed,
    standalone: steps.length === 1 && !["read", "edit", "write", "delete", "command"].includes(kind) };
}
