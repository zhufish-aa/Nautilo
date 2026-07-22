import type { SessionStatus } from "@agenthub/domain";
import type { RunLifecycle } from "./types";

export function isActiveLifecycle(lifecycle?: RunLifecycle): boolean {
  return lifecycle?.status === "running" || lifecycle?.status === "waiting_approval";
}

/** The orchestration outlives an individual provider turn in the main session. */
export function visibleSessionStatus(sessionStatus: SessionStatus, orchestration?: RunLifecycle): SessionStatus {
  if (orchestration?.status === "running") return "running";
  if (orchestration?.status === "waiting_approval") return "waiting_approval";
  return sessionStatus;
}
