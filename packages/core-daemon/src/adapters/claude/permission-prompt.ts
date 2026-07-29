import type { AdapterInteractionInput } from "../types.js";
import type { InteractionResponse } from "@agenthub/domain";
import type { PermissionPromptRequest, PermissionPromptResult } from "../runtime-mcp-bridge.js";
import { extractInteractionPlan, isPlanExitTool } from "../plan-interaction.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => typeof value === "object" && value !== null ? value as RecordValue : {};

type InteractionHandler = (input: AdapterInteractionInput) => Promise<InteractionResponse>;

/**
 * Maps Claude Code's --permission-prompt-tool calls onto AgentHub interactions.
 * AskUserQuestion is answered with `updatedInput.answers` (keyed by question
 * text, values joined for multi-select); everything else is an allow/deny
 * approval. Cancelling denies, which lets the agent continue without the tool.
 */
export function buildClaudePermissionPromptHandler(
  requestInteraction: InteractionHandler
): (request: PermissionPromptRequest) => Promise<PermissionPromptResult> {
  return async ({ toolName, input }) => {
    if (toolName === "AskUserQuestion") {
      const questions = (Array.isArray(input.questions) ? input.questions : []).map(record).map((question, index) => {
        const text = String(question.question ?? `question-${index + 1}`);
        return {
          id: text,
          header: typeof question.header === "string" ? question.header : undefined,
          question: text,
          multiSelect: question.multiSelect === true || undefined,
          options: Array.isArray(question.options)
            ? question.options.map(record).map((option) => ({
                id: String(option.label ?? ""),
                label: String(option.label ?? ""),
                description: typeof option.description === "string" ? option.description : undefined
              })).filter((option) => option.id)
            : undefined
        };
      });
      const response = await requestInteraction({ kind: "question", title: "提问", questions });
      if (response.outcome !== "selected") return { behavior: "deny", message: "User cancelled the question." };
      const answers: Record<string, string> = {};
      for (const question of questions) {
        const values = response.answers?.[question.id] ?? [];
        if (values.length) answers[question.id] = values.join(", ");
      }
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    if (isPlanExitTool(toolName)) {
      const response = await requestInteraction({
        kind: "plan_approval",
        title: "计划已就绪",
        plan: extractInteractionPlan(input),
        options: [
          { id: "allow", label: "Approve", intent: "approve" },
          { id: "deny", label: "Revise", intent: "revise" }
        ]
      });
      if (response.outcome === "selected" && response.optionId === "allow") {
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: "User chose to continue refining the plan in AgentHub." };
    }
    const response = await requestInteraction({
      kind: "approval",
      title: toolName || "权限请求",
      detail: JSON.stringify(input, null, 2).slice(0, 4_000),
      options: [
        { id: "allow", label: "allow" },
        { id: "deny", label: "deny" }
      ]
    });
    if (response.outcome === "selected" && response.optionId === "allow") return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: "User denied this action in AgentHub." };
  };
}
