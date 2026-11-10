import type { Session } from "@agenthub/domain";
import type { Database } from "../database/index.js";
import { CoreError } from "../errors.js";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "timed_out", "crashed", "cancelled"]);

/** Legacy conversations stored the CLI instance in memberId or a team member. */
function agentIdentity(session: Session, database: Database): string {
  if (session.agentInstanceId) return session.agentInstanceId;
  if (session.teamId) {
    const member = database.teams.get(session.teamId)?.members.find((item) => item.id === session.memberId);
    if (member) return member.agentInstanceId;
  }
  return session.memberId;
}

/** Guard persisted history, not renderer status; routing metadata is not identity. */
export function assertSessionIdentityUpdate(current: Session, input: Session, database: Database): void {
  const updated = { ...current, ...input };
  const runs = database.runs.list().filter((run) => run.sessionId === current.id);
  const started = Boolean(current.providerSessionId) || runs.length > 0 || database.sessions.messages(current.id).length > 0;
  if (started) {
    if (current.projectId !== updated.projectId) {
      throw new CoreError("IPC_INVALID_REQUEST", { field: "projectId", reason: "Start a new session to change the project after a conversation has started." });
    }
    if (agentIdentity(current, database) !== agentIdentity(updated, database)) {
      throw new CoreError("IPC_INVALID_REQUEST", { field: "agentInstanceId", reason: "Start a new session to change the agent after a conversation has started." });
    }
  }
  if (runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status))) {
    for (const field of ["model", "reasoningEffort", "serviceTier"] as const) {
      if ((current[field] ?? undefined) !== (updated[field] ?? undefined)) {
        throw new CoreError("IPC_INVALID_REQUEST", { field, reason: "Wait for the active run to finish before changing request settings." });
      }
    }
  }
}
