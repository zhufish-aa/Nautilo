import type { AgentRun, Session } from "@agenthub/domain";
import type { ProjectEventCursor, ProjectPollInput, ProjectPollSnapshot, ProjectPollResult } from "@agenthub/schemas";
import type { Database } from "./index.js";
import { readSnapshot } from "./history-projection.js";
import { CoreError } from "../errors.js";

type Clock = { epoch: string; revision: number };
export function projectPollSessions(database: Database, input: ProjectPollInput): Session[] {
  if (!input || (input.sessions !== undefined && !Array.isArray(input.sessions)) || (input.visibleSessionIds !== undefined && !Array.isArray(input.visibleSessionIds)) || typeof input.projectRunId !== "string" || !input.projectRunId || (input.sessions?.length ?? 0) > 2048 || (input.visibleSessionIds?.length ?? 0) > 2048) {
    throw new CoreError("IPC_INVALID_REQUEST", { reason: "projectRun.poll requires a project run and at most 2048 session cursors" });
  }
  const projectRun = database.projectRuns.get(input.projectRunId);
  if (!projectRun) throw new CoreError("IPC_NOT_FOUND", { resource: "projectRun", id: input.projectRunId });
  return database.sessions.list(projectRun.projectId).filter((session) => session.projectRunId === input.projectRunId);
}
function eventReset(database: Database, sessionId: string, cursor: ProjectEventCursor | undefined, clock: Clock, lastSequence: number): boolean {
  const invalidation = database.connection.raw.prepare("SELECT MAX(revision) AS revision FROM read_projection_invalidations WHERE scope IN (?, ?)")
    .get(`events:session:${sessionId}`, `messages:session:${sessionId}`) as { revision?: number };
  return !cursor || cursor.scope !== `events:session:${sessionId}` || cursor.epoch !== clock.epoch
    || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 || cursor.sequence > lastSequence
    || !Number.isSafeInteger(cursor.revision) || cursor.revision < (invalidation.revision ?? 0) || cursor.revision > clock.revision;
}
function eventClock(database: Database): Clock {
  return database.connection.raw.prepare("SELECT epoch, revision FROM read_projection_clock WHERE id = 1").get() as Clock;
}
export function projectPollLastSequence(database: Database, sessionId: string): number {
  return Number((database.connection.raw.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM runtime_events WHERE session_id = ?").get(sessionId) as { sequence: number }).sequence);
}
/** Resolve full-replay healing before opening the read-only snapshot. */
export function projectPollHealIds(database: Database, input: ProjectPollInput): string[] {
  return readSnapshot(database.connection.raw, () => {
    const clock = eventClock(database);
    const cursors = new Map((input.sessions ?? []).map((item) => [item.sessionId, item.eventCursor]));
    const sessions = projectPollSessions(database, input);
    if (sessions.length > 64) return [];
    return sessions.filter((session) => eventReset(database, session.id, cursors.get(session.id), clock, projectPollLastSequence(database, session.id))).map((session) => session.id);
  });
}

export function readProjectPoll(database: Database, input: ProjectPollInput, followUps: ProjectPollSnapshot["followUps"] = []): ProjectPollResult {
  return readSnapshot(database.connection.raw, () => {
    const sessions = projectPollSessions(database, input);
    const projectRun = database.projectRuns.get(input.projectRunId)!;
    if (sessions.length > 64) return { fallback: true as const, projectRun };
    const clock = eventClock(database);
    const cursors = new Map((input.sessions ?? []).map((item) => [item.sessionId, item]));
    const ids = new Set(sessions.map((session) => session.id));
    const children = new Map<string, string[]>();
    for (const session of sessions) if (session.parentSessionId) {
      const list = children.get(session.parentSessionId) ?? []; list.push(session.id); children.set(session.parentSessionId, list);
    }
    const needed = new Set((input.visibleSessionIds ?? []).filter((id) => ids.has(id)));
    const queue = [...needed];
    for (let index = 0; index < queue.length; index += 1) for (const child of children.get(queue[index]!) ?? []) {
      if (!needed.has(child)) { needed.add(child); queue.push(child); }
    }
    const feeds = sessions.map((session) => {
      const previous = cursors.get(session.id)?.eventCursor;
      const sequence = projectPollLastSequence(database, session.id);
      const reset = eventReset(database, session.id, previous, clock, sequence);
      const events = database.events.replay({ sessionId: session.id, afterSequence: reset ? 0 : previous!.sequence });
      return { sessionId: session.id, reset, events, cursor: { ...clock, scope: `events:session:${session.id}`, sequence } };
    });
    const runs = database.connection.raw.prepare("SELECT runs.data FROM runs JOIN sessions ON sessions.id = runs.session_id WHERE sessions.project_id = ? AND json_extract(sessions.data, '$.projectRunId') = ? ORDER BY runs.updated_at DESC")
      .all(projectRun.projectId, input.projectRunId).map((row) => JSON.parse(String(row.data)) as AgentRun);
    return {
      projectRun, sessions, runs, tasks: database.tasks.list(input.projectRunId), verifications: database.verifications.list(input.projectRunId),
      artifacts: database.artifacts.changes({ projectRunId: input.projectRunId, cursor: input.artifactCursor }), feeds,
      histories: sessions.filter((session) => needed.has(session.id)).map((session) => database.sessions.history(session.id, cursors.get(session.id)?.historyCursor)),
      followUps: followUps.filter((entry) => ids.has(entry.sessionId))
    };
  });
}
