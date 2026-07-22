import type { RunMode } from "@agenthub/domain";
import type { AdapterCapabilities } from "./types.js";

export type SessionResumeStrategy = "native" | "prompt_reconstruction" | "none";

export function negotiateRunMode(capabilities: AdapterCapabilities, preferred: RunMode[]): RunMode {
  const supported = new Set<RunMode>([
    ...(capabilities.structuredOutput ? ["headless_structured" as const] : []),
    ...(capabilities.textOutput ? ["headless_text" as const] : []),
    ...(capabilities.interactiveStdin ? ["long_running_stdin" as const] : []),
    ...(capabilities.pty ? ["pty_interactive" as const] : [])
  ]);
  const selected = preferred.find((mode) => supported.has(mode));
  if (!selected) throw new Error("Provider has no compatible run mode");
  return selected;
}

export function resumeStrategy(capabilities: AdapterCapabilities, canReconstructPrompt = true): SessionResumeStrategy {
  return capabilities.nativeResume ? "native" : canReconstructPrompt ? "prompt_reconstruction" : "none";
}
