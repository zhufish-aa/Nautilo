import type { RuntimeToolCall, RuntimeToolExecutor, RuntimeToolResult, RuntimeToolSpec } from "@agenthub/provider-sdk";

export type { RuntimeToolCall, RuntimeToolExecutor, RuntimeToolResult, RuntimeToolSpec };

export function runtimeToolText(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); }
  catch { return String(value); }
}
