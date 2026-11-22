import type { UsageRates } from "@agenthub/schemas";

const rates = (input: number, output: number, cacheRead: number, cacheWrite?: number): UsageRates => ({ input, output, cacheRead, cacheWrite });
// Standard text API USD rates per million tokens. Short-context and default
// cache-write lifetime where the provider publishes more than one rate.
const reference = new Map<string, UsageRates>([
  // https://developers.openai.com/api/docs/pricing
  ["gpt-6.2-astra", rates(8, 40, .4, 10)],
  ["gpt-6.2-sol", rates(2, 10, .1, 2.5)],
  ["gpt-6.1-sol", rates(2, 10, .1, 2.5)],
  ["gpt-6-luna", rates(.1, .5, .01, .125)],
  ["gpt-5.4", rates(2.5, 15, .25)],
  ["gpt-5.4-mini", rates(.75, 4.5, .075)],
  // https://platform.claude.com/docs/en/about-claude/pricing
  ["claude-opus-4-8", rates(5, 25, .5, 6.25)],
  ["claude-opus-4-6", rates(5, 25, .5, 6.25)],
  ["claude-sonnet-4-6", rates(3, 15, .3, 3.75)],
  ["claude-sonnet-4-5", rates(3, 15, .3, 3.75)],
  ["claude-haiku-4-5", rates(1, 5, .1, 1.25)],
  // https://ai.google.dev/gemini-api/docs/pricing
  ["gemini-2.5-flash", rates(.3, 2.5, .03)],
  // https://api-docs.deepseek.com/quick_start/pricing/
  ["deepseek-flash", rates(.3, 1.2, .006, .3)],
  ["deepseek-v4.1-flash", rates(.3, 1.2, .006, .3)],
  // https://forum.moonshot.ai/t/an-update-on-new-k2-models-and-new-pricing/104
  ["kimi-k2-turbo", rates(1.15, 8, .15)],
  ["kimi-k2-thinking-turbo", rates(1.15, 8, .15)],
]);

export function referenceRates(model: string | undefined, now: Date): UsageRates | undefined {
  const id = model?.toLowerCase().replace(/^(?:openai|anthropic|google|deepseek|models|moonshot|kimi-code)\//, "")
    .replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
  if (id === "gemini-3.8-flash") return now.getTime() < Date.UTC(2027, 0, 1) ? rates(.75, 3.75, .075) : rates(1.5, 7.5, .15);
  return id ? reference.get(id) : undefined;
}
