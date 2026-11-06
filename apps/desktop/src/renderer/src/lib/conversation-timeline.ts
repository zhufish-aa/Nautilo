import type { TimelineEvent } from "./types";

const dispatchReceiptCache = new WeakMap<TimelineEvent, string[]>();
const dispatchCardCache = new WeakMap<TimelineEvent, { call: TimelineEvent; card: TimelineEvent }>();
const delegateName = /(?:^|[.:/]|__)agenthub_delegate$/;

/** Read only explicit task receipts, never infer a match from prompt/member text. */
function dispatchTaskIds(event: TimelineEvent): string[] {
  const data = event.data;
  if (data.kind !== "tool_activity" || data.status !== "done" || data.subagent
    || !delegateName.test(data.toolName) || !data.output) return [];
  const cached = dispatchReceiptCache.get(event);
  if (cached) return cached;
  const ids = new Set<string>();
  const read = (value: unknown, depth = 0): void => {
    if (depth > 12) return;
    if (typeof value === "string") {
      try { read(JSON.parse(value), depth + 1); } catch { /* Incomplete/legacy receipts stay visible. */ }
      return;
    }
    if (Array.isArray(value)) { for (const item of value) read(item, depth + 1); return; }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (object.success === false || object.isError === true || (object.accepted === false && object.approvalRequired !== true)) return;
    if (typeof object.taskId === "string") ids.add(object.taskId);
    for (const key of ["tasks", "content", "contentItems", "text", "structuredContent", "result"]) {
      if (object[key] !== undefined) read(object[key], depth + 1);
    }
  };
  read(data.output);
  const result = [...ids];
  dispatchReceiptCache.set(event, result);
  return result;
}

/** Flatten groups; attach successful dispatch receipts to their existing task
 * row. Keep source events, unmatched/failed calls, and stable task row IDs. */
export function conversationTimeline(events: readonly TimelineEvent[]): TimelineEvent[] {
  const rows: TimelineEvent[] = [];
  const visit = (items: readonly TimelineEvent[]): void => {
    for (const event of items) {
      const data = event.data;
      if (data.kind === "tool_group") visit(data.items);
      else if (data.kind === "usage") continue;
      else if (data.kind === "activity" && data.phase !== "stopped") continue;
      else if (data.kind === "run_status" && data.run.status === "completed") continue;
      else rows.push(event);
    }
  };
  visit(events);
  const taskKey = (event: TimelineEvent, id: string): string => `${event.sessionId}:${id}`;
  const tasks = new Set(rows.flatMap((event) => event.data.kind === "task_update" ? [taskKey(event, event.data.taskId)] : []));
  const calls = new Map<string, TimelineEvent>();
  const merged = new Set<TimelineEvent>();
  for (const event of rows) {
    const ids = dispatchTaskIds(event);
    if (!ids.length || !ids.every((id) => tasks.has(taskKey(event, id))) || ids.some((id) => calls.has(taskKey(event, id)))) continue;
    for (const id of ids) calls.set(taskKey(event, id), event);
    merged.add(event);
  }
  // Older Codex dynamic-tool events omitted their result. Match those only
  // when one exact member + full objective has one call and one task in the
  // same user turn. Ambiguous repeats, failures and partial receipts stay put.
  const legacy = new Map<string, { calls: TimelineEvent[]; tasks: TimelineEvent[] }>();
  const turns = new Map<string, string>();
  for (const event of rows) {
    const data = event.data;
    if (data.kind === "message" && data.sender === "user") turns.set(event.sessionId, event.id);
    let memberId: string | undefined;
    let objective: string | undefined;
    if (data.kind === "task_update") {
      memberId = data.memberId;
      objective = data.objective;
    } else if (data.kind === "tool_activity" && data.status === "done" && !data.subagent && delegateName.test(data.toolName)) {
      try {
        const input = JSON.parse(data.input ?? "") as Record<string, unknown>;
        if (typeof input?.memberId === "string" && typeof input.task === "string") {
          memberId = input.memberId;
          objective = input.task;
        }
      } catch { /* Unparseable input cannot establish identity. */ }
    }
    if (!memberId || !objective) continue;
    const key = JSON.stringify([event.sessionId, turns.get(event.sessionId), memberId, objective]);
    const bucket = legacy.get(key) ?? { calls: [], tasks: [] };
    bucket[data.kind === "task_update" ? "tasks" : "calls"].push(event);
    legacy.set(key, bucket);
  }
  for (const bucket of legacy.values()) {
    if (bucket.calls.length !== 1 || bucket.tasks.length !== 1) continue;
    const [call] = bucket.calls;
    const [task] = bucket.tasks;
    if (call.data.kind !== "tool_activity" || call.data.output?.trim() || task.data.kind !== "task_update") continue;
    const key = taskKey(task, task.data.taskId);
    if (calls.has(key)) continue;
    calls.set(key, call);
    merged.add(call);
  }
  if (!merged.size) return rows;
  return rows.filter((event) => !merged.has(event)).map((event) => {
    if (event.data.kind !== "task_update") return event;
    const call = calls.get(taskKey(event, event.data.taskId));
    if (!call || call.data.kind !== "tool_activity") return event;
    const cached = dispatchCardCache.get(event);
    if (cached?.call === call) return cached.card;
    const { toolName, input, output } = call.data;
    const card = { ...event, data: { ...event.data, dispatchCall: { toolName, input, output } } };
    dispatchCardCache.set(event, { call, card });
    return card;
  });
}

export interface ConversationTurn {
  id: string;
  events: TimelineEvent[];
  completed: boolean;
  result?: TimelineEvent;
  /** Foreground elapsed time; late child/background updates do not extend it. */
  durationMs?: number;
}

export type ConversationRow = { kind: "event"; event: TimelineEvent } | { kind: "turn"; turn: ConversationTurn };

/** Keep a turn expanded until its final output finishes, then separate the result. */
export function conversationRows(events: readonly TimelineEvent[], running: boolean): ConversationRow[] {
  const rows: ConversationRow[] = [];
  const timings = new Map<string, { start?: number; end?: number }>();
  const recordTiming = (event: TimelineEvent): void => {
    if (event.data.kind === "tool_group") { event.data.items.forEach(recordTiming); return; }
    if (!event.runId || event.background) return;
    const timing = timings.get(event.runId) ?? {};
    const time = Date.parse(event.timestamp);
    const data = event.data;
    const start = data.kind === "run_status" && data.run.startedAt ? Date.parse(data.run.startedAt)
      : data.kind === "activity" && data.phase === "starting" ? time : undefined;
    if (start !== undefined && Number.isFinite(start)) timing.start = Math.min(timing.start ?? start, start);
    if (Number.isFinite(time) && (data.kind === "activity" && ["completed", "stopped"].includes(data.phase)
      || data.kind === "run_status" && ["completed", "failed", "cancelled"].includes(data.run.status))) timing.end = Math.max(timing.end ?? time, time);
    timings.set(event.runId, timing);
  };
  events.forEach(recordTiming);
  const turnStarts = new Map<string, number>();
  const finishedRuns = new Set(events.filter((event) => event.runId && (
    event.data.kind === "activity" && ["completed", "stopped"].includes(event.data.phase)
    || event.data.kind === "run_status" && ["completed", "failed", "cancelled"].includes(event.data.run.status)
  )).map((event) => event.runId));
  let turn: TimelineEvent[] = [];
  let turnId = "";
  const origins=new Map<string,TimelineEvent[]>();
  const flush = (): void => {
    if (!turn.length) return;
    rows.push({kind:"turn",turn:{id:turnId || `turn-${turn[0]!.id}`,events:turn,completed:false}});
    turn=[];
  };
  for (const event of conversationTimeline(events)) {
    if (event.data.kind === "message" && event.data.sender !== "agent") {
      flush();
      rows.push({ kind: "event", event });
      turnId = `turn-${event.id}`;
      if (Number.isFinite(Date.parse(event.timestamp))) turnStarts.set(turnId, Date.parse(event.timestamp));
    } else {
      const origin=event.background && event.runId ? origins.get(event.runId) : undefined;
      if (origin && origin!==turn) {origin.push(event);continue;}
      turn.push(event);
      if(event.runId)origins.set(event.runId,turn);
    }
  }
  flush();
  for (const [index,row] of rows.entries()) {
    if(row.kind!=="turn")continue;
    const turn=row.turn.events;
    const last=index===rows.length-1;
    const lastRunId = [...turn].reverse().find((event) => event.runId)?.runId;
    const streaming = turn.some((event) => !event.background && event.data.kind === "message" && event.data.streaming);
    const completed = !streaming && (!running || Boolean(lastRunId && finishedRuns.has(lastRunId)) || (!last && !lastRunId));
    const lastContent = [...turn].reverse().find((event) => !["activity", "run_status", "error", "approval"].includes(event.data.kind));
    // Keep the current reply in the same DOM slot while streaming and after
    // persistence/completion. Moving it out of the process fold remounts its
    // Markdown and briefly clears/reanimates an already visible answer.
    const result = lastContent?.data.kind === "message" && lastContent.data.sender === "agent" ? lastContent
      : completed ? [...turn].reverse().find((event) => event.data.kind === "message" && event.data.sender === "agent") : undefined;
    row.turn.completed=completed;
    row.turn.result=result;
    if (completed) {
      const foreground = turn.filter(event => !event.background);
      const clocks = [...new Set(foreground.map(event => event.runId).filter((id): id is string => Boolean(id)))].map(id => timings.get(id));
      const starts = clocks.flatMap(clock => clock?.start === undefined ? [] : [clock.start]);
      const ends = clocks.flatMap(clock => clock?.end === undefined ? [] : [clock.end]);
      const start = starts.length ? Math.min(...starts) : turnStarts.get(row.turn.id);
      const lastTime = foreground.length ? Date.parse(foreground[foreground.length - 1]!.timestamp) : undefined;
      const end = ends.length ? Math.max(...ends) : lastTime;
      if (start !== undefined && end !== undefined && Number.isFinite(end) && end >= start) row.turn.durationMs = end - start;
    }
  }
  return rows;
}
