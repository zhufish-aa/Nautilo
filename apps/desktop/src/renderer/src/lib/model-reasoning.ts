export const DEFAULT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Defaults for newly added/discovered models, before a user saves overrides. */
export function withDefaultReasoning<T extends { defaultReasoningEffort?: string }>(model: T): T & { reasoningEfforts: string[]; defaultReasoningEffort: string } {
  const defaultReasoningEffort = model.defaultReasoningEffort || "low";
  const reasoningEfforts = [...DEFAULT_REASONING_EFFORTS];
  if (!reasoningEfforts.includes(defaultReasoningEffort)) reasoningEfforts.push(defaultReasoningEffort);
  return { ...model, reasoningEfforts, defaultReasoningEffort };
}
