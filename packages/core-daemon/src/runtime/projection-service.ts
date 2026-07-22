import type { AgentRunStatus, SessionStatus } from "@agenthub/domain";
import { Database } from "../database/index.js";

export interface SessionProjection { sessionStatus: SessionStatus; runStatus?: AgentRunStatus; lastSequence: number; }

/** Pure event-to-state projection used at startup and after reconnects. */
export class ProjectionService {
  constructor(private readonly database: Database) {}
  rebuildSession(sessionId: string): SessionProjection {
    const events = this.database.events.replay({ sessionId });
    let sessionStatus: SessionStatus = "idle";
    let runStatus: AgentRunStatus | undefined;
    for (const event of events) {
      if (event.type === "run.started") { sessionStatus = "running"; runStatus = "running"; }
      else if (event.type === "run.waiting") {
        sessionStatus = event.payload.reason === "approval" ? "waiting_approval" : "waiting_input";
        runStatus = event.payload.reason === "approval" ? "waiting_approval" : "waiting_input";
      } else if (event.type === "run.completed") { sessionStatus = "completed"; runStatus = "completed"; }
      else if (event.type === "run.failed") { sessionStatus = "failed"; runStatus = "failed"; }
    }
    return { sessionStatus, runStatus, lastSequence: events.at(-1)?.sequence ?? 0 };
  }
}
