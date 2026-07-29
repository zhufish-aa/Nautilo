import type { AdapterInteractionInput } from "../types.js";
import { extractInteractionPlan, isPlanExitTool, withPlanOptionIntents } from "../plan-interaction.js";

type RecordValue = Record<string, unknown>;

/** Normalizes one ACP permission request without leaking provider JSON to UI. */
export function normalizeKimiPermissionInteraction(
  toolCall: RecordValue,
  options: RecordValue[]
): AdapterInteractionInput {
  const planApproval = isPlanExitTool(toolCall.title) || isPlanExitTool(toolCall.kind);
  const normalizedOptions = options.map((option) => ({
    id: String(option.optionId ?? ""),
    label: String(option.name ?? option.optionId ?? ""),
    description: typeof option.kind === "string" ? option.kind : undefined
  })).filter((option) => option.id);
  return {
    kind: planApproval ? "plan_approval" : "approval",
    title: planApproval ? "计划已就绪" : String(toolCall.title ?? "") || "权限请求",
    detail: planApproval ? undefined : [
      typeof toolCall.kind === "string" ? `类型: ${toolCall.kind}` : undefined,
      toolCall.content !== undefined ? JSON.stringify(toolCall.content, null, 2).slice(0, 4_000) : undefined
    ].filter(Boolean).join("\n") || undefined,
    plan: planApproval ? extractInteractionPlan(toolCall.content ?? toolCall) : undefined,
    options: planApproval ? withPlanOptionIntents(normalizedOptions) : normalizedOptions
  };
}
