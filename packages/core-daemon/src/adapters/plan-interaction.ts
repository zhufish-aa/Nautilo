import type { InteractionOption, InteractionPlan } from "@agenthub/domain";

type RecordValue = Record<string, unknown>;

const PLAN_TOOL_NAMES = new Set([
  "exitplanmode",
  "exit_plan_mode",
  "plan_exit",
  "exit-plan-mode"
]);

const TEXT_KEYS = ["plan", "markdown", "text", "content", "output", "message", "description"] as const;
const PATH_KEYS = ["planPath", "plan_path", "filePath", "file_path", "path"] as const;

function record(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null ? value as RecordValue : undefined;
}

export function isPlanExitTool(name: unknown): boolean {
  return PLAN_TOOL_NAMES.has(String(name ?? "").trim().toLowerCase());
}

function collectText(value: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectText(item, depth + 1));
  const item = record(value);
  if (!item) return [];
  return TEXT_KEYS.flatMap((key) => key in item ? collectText(item[key], depth + 1) : []);
}

function findPath(value: unknown, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const path = findPath(item, depth + 1);
      if (path) return path;
    }
    return undefined;
  }
  const item = record(value);
  if (!item) return undefined;
  for (const key of PATH_KEYS) {
    const path = item[key];
    if (typeof path === "string" && /\.md(?:own)?$/i.test(path.trim())) return path.trim();
  }
  for (const key of TEXT_KEYS) {
    const path = findPath(item[key], depth + 1);
    if (path) return path;
  }
  return undefined;
}

function cleanCandidate(text: string): { content: string; sourcePath?: string } {
  let content = text.replace(/\r\n?/g, "\n").trim();
  let sourcePath: string | undefined;
  const saved = content.match(/^Plan saved to:\s*(.+?)\s*\n+/i);
  if (saved) {
    sourcePath = saved[1]?.trim();
    content = content.slice(saved[0].length);
  }
  content = content
    .replace(/\n+\s*Requesting approval to (?:present(?:ing)?|show) the plan[\s\S]*$/i, "")
    .replace(/\n+\s*Requesting approval to .*exit(?:ing)? plan mode[\s\S]*$/i, "")
    .trim();
  return { content, sourcePath };
}

/**
 * Extracts a readable plan from provider-native nested content. Providers may
 * send a plain `plan` string, content blocks, or a status wrapper containing
 * "Plan saved to: …" plus the full Markdown document.
 */
export function extractInteractionPlan(value: unknown): InteractionPlan {
  const candidates = collectText(value)
    .map(cleanCandidate)
    .filter((candidate) => candidate.content && !isPlanExitTool(candidate.content));
  const best = candidates.sort((left, right) => {
    const score = (candidate: { content: string }): number =>
      candidate.content.length + (/(^|\n)#{1,3}\s/.test(candidate.content) ? 10_000 : 0);
    return score(right) - score(left);
  })[0];
  return {
    content: best?.content ?? "",
    sourcePath: best?.sourcePath ?? findPath(value)
  };
}

function optionIntent(text: string): InteractionOption["intent"] | undefined {
  const normalized = text.toLowerCase();
  if (/(reject|deny|decline|cancel|abort|拒绝|取消)/i.test(normalized)) return "reject";
  if (/(revise|refine|keep planning|continue planning|stay.+plan|修改|完善|继续计划)/i.test(normalized)) return "revise";
  if (/(allow|accept|approve|proceed|implement|build|yes|批准|执行|开始实现|同意)/i.test(normalized)) return "approve";
  return undefined;
}

export function withPlanOptionIntents(options: InteractionOption[]): InteractionOption[] {
  const inferred = options.map((option) => ({
    ...option,
    intent: option.intent ?? optionIntent(`${option.id} ${option.label} ${option.description ?? ""}`)
  }));
  if (inferred.length === 2 && !inferred.some((option) => option.intent === "approve")) {
    inferred[0] = { ...inferred[0]!, intent: "approve" };
  }
  if (inferred.length === 2 && !inferred.some((option) => option.intent === "revise" || option.intent === "reject")) {
    inferred[1] = { ...inferred[1]!, intent: "revise" };
  }
  return inferred;
}

export function looksLikePlanApprovalQuestion(
  title: unknown,
  questions: Array<{ question: string; header?: string; options?: InteractionOption[] }>
): boolean {
  if (questions.length !== 1 || (questions[0]?.options?.length ?? 0) < 2) return false;
  const text = [
    String(title ?? ""),
    questions[0]?.header ?? "",
    questions[0]?.question ?? "",
    ...(questions[0]?.options ?? []).flatMap((option) => [option.label, option.description ?? ""])
  ].join(" ");
  return /(plan|计划)/i.test(text)
    && /(approve|implement|build agent|start implementing|switch|批准|执行|开始实现|切换)/i.test(text);
}
