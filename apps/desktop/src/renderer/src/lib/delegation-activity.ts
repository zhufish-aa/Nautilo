import type { TimelinePayload } from "./types";
import { reasoningPreview } from "./process-display";

/** Summaries come from observed child events, never from the dispatch receipt. */
export function delegationActivity(data: TimelinePayload | undefined, zh: boolean): string | undefined {
  if (!data) return;
  let text: string | undefined;
  switch (data.kind) {
    case "message": text = data.sender === "agent" ? data.text : undefined; break;
    case "reasoning": text = reasoningPreview(data.text); break;
    case "tool_activity": text = data.toolName; break;
    case "command": text = `${zh ? "运行" : "Run"} · ${data.command}`; break;
    case "file_change": text = data.files.map(file => file.path).join(" · "); break;
    case "error": text = `${data.code} · ${data.message}`; break;
  }
  return text?.replace(/\s+/g," ").trim().slice(0,240) || undefined;
}
