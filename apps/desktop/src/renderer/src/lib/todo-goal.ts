import type { TimelineEvent } from "./types";

export interface TodoGoalItem {
  title: string;
  status: "pending" | "in_progress" | "done";
}

/** Todo-tracking tool names across providers (Kimi TodoList, Claude TodoWrite, Codex update_plan). */
const TODO_TOOL_NAMES = new Set(["todolist", "todo_list", "todowrite", "todo_write", "update_plan"]);

function isTodoTool(toolName: string): boolean {
  return TODO_TOOL_NAMES.has(toolName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"));
}

function normalizeStatus(raw: unknown): TodoGoalItem["status"] {
  const value = String(raw ?? "").trim().toLowerCase();
  if (["done", "completed", "complete", "finished"].includes(value)) return "done";
  if (["in_progress", "in-progress", "inprogress", "doing", "active", "running"].includes(value)) return "in_progress";
  return "pending";
}

/**
 * Parses the input of a todo-tracking tool call into a flat item list.
 * Tolerates the field naming of different providers: the list may live under
 * `todos`/`plan`/`tasks`, and an item's text under `title`/`content`/`step`.
 * Returns undefined when the input is missing, truncated, or unrecognized.
 */
export function extractTodoItems(input: string | undefined): TodoGoalItem[] | undefined {
  if (!input?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const root = parsed as Record<string, unknown>;
  const nested = typeof root.arguments === "object" && root.arguments !== null && !Array.isArray(root.arguments)
    ? root.arguments as Record<string, unknown>
    : root;
  const list = [nested.todos, nested.plan, nested.tasks, nested.items].find(Array.isArray);
  if (!list) return undefined;
  const items: TodoGoalItem[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const title = [record.title, record.content, record.step, record.label, record.task]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
    if (!title) continue;
    items.push({ title: title.trim(), status: normalizeStatus(record.status) });
  }
  return items.length > 0 ? items : undefined;
}

/**
 * Finds the most recent todo tool call in a session timeline, looking through
 * standalone tool rows and grouped tool rows alike. The latest call carries the
 * full list, so a single hit is enough.
 */
export function latestTodoGoal(events: TimelineEvent[]): TodoGoalItem[] | undefined {
  const fromActivity = (data: TimelineEvent["data"]): TodoGoalItem[] | undefined =>
    data.kind === "tool_activity" && isTodoTool(data.toolName) ? extractTodoItems(data.input) : undefined;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const data = events[index].data;
    const direct = fromActivity(data);
    if (direct) return direct;
    if (data.kind === "tool_group") {
      for (let item = data.items.length - 1; item >= 0; item -= 1) {
        const grouped = fromActivity(data.items[item].data);
        if (grouped) return grouped;
      }
    }
  }
  return undefined;
}
