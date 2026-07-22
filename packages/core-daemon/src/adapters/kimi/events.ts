import { normalizeJson } from "../normalize.js";
import type { AdapterEvent } from "../types.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; }
  catch { return value; }
}

export function parseKimiJsonEvent(value: unknown): AdapterEvent[] {
  const event = record(value);
  if (!event) return normalizeJson(value);

  if (event.role === "assistant") {
    const events: AdapterEvent[] = [];
    if (typeof event.content === "string" && event.content) events.push({ kind: "message", text: event.content, raw: value });
    if (Array.isArray(event.tool_calls)) {
      for (const callValue of event.tool_calls) {
        const call = record(callValue);
        const fn = record(call?.function);
        if (typeof fn?.name === "string") events.push({ kind: "tool", name: fn.name, phase: "started", input: parseArguments(fn.arguments), raw: value });
      }
    }
    return events;
  }
  if (event.role === "tool") {
    return [{ kind: "tool", name: typeof event.tool_call_id === "string" ? event.tool_call_id : "tool", phase: "completed", output: event.content, raw: value }];
  }
  if (event.role === "meta" && event.type === "session.resume_hint" && typeof event.session_id === "string") {
    return [{ kind: "session", providerSessionId: event.session_id, raw: value }];
  }
  if (event.role === "error" || event.type === "error") {
    const message = typeof event.content === "string" ? event.content : typeof event.message === "string" ? event.message : "Kimi Code reported an error";
    return [{ kind: "error", error: new Error(message) }];
  }
  return normalizeJson(value);
}
