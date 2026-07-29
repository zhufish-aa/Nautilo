export const RUNTIME_TOOL_NAMES = {
  delegate: "agenthub_delegate",
  plan: "agenthub_plan"
} as const;

/** Accepts legacy dotted names while all newly registered tools use provider-safe names. */
export function normalizeRuntimeToolName(name: string): string {
  if (name === "agenthub.delegate") return RUNTIME_TOOL_NAMES.delegate;
  if (name === "agenthub.plan") return RUNTIME_TOOL_NAMES.plan;
  return name;
}
