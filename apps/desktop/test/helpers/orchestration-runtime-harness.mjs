import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const lib = new URL("../../src/renderer/src/lib/", import.meta.url);
const compile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
export const helperModules = {};
for (const name of ["context-usage", "deepseek-legacy-history", "process-display", "orchestration-timeline-policy", "tool-timeline-groups", "subagent-activities", "provider-diff", "tool-display", "changed-files"]) {
  const exports = {};
  vm.runInNewContext(compile(readFileSync(new URL(`${name}.ts`, lib), "utf8")), {
    exports, TextEncoder, TextDecoder, require: (name) => helperModules[name]
  });
  helperModules[`./${name}`] = exports;
}
const runtimeSource = readFileSync(new URL("orchestration-runtime.ts", lib), "utf8");

// Runs the real runtime and timeline builders with deterministic IPC and clock.
// No desktop, daemon, provider process, network, or model requests are made.
export function createHarness({ source = runtimeSource, ipcDelay = 40, agentCount = 1, failMethod, bridgeAvailable = true, interactionsModule } = {}) {
  let now = 10_000, nextTimer = 1, nextMessage = 1;
  const timers = new Map(), calls = [], renders = [];
  const setTimeout = (fn, delay = 0) => { const id = nextTimer++; timers.set(id, { fn, at: now + delay }); return id; };
  const clearTimeout = (id) => timers.delete(id);
  const session = { id: "s", projectId: "p", target: { type: "agent", instanceId: "a0" }, status: "idle", mode: "chat", createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z" };
  const instances = Array.from({ length: agentCount }, (_, i) => ({ id: `a${i}`, executable: "fake", displayName: `Agent ${i}` }));
  const team = { id: "t", members: instances.map((instance) => ({ agentInstanceId: instance.id, enabled: true })) };
  const state = {
    providerCommandRevisions: {}, sessions: [session], tasks: {}, artifacts: {}, foreground: {}, running: {}, activeAgentRunIds: {}, events: { s: [] }, queuedFollowUps: { s: [] },
    _append: (id, data) => {
      const event = { id: data.kind === "message" && data.messageId ? `message-${data.messageId}` : `local-${state.events[id].length}`, sessionId: id, timestamp: session.createdAt, sequence: 0, data };
      state.events[id].push(event);
      return event;
    },
    _replaceEvents: (id, rows) => { state.events[id] = rows; renders.push({ at: now, rows }); },
    _replaceContextUsage() {}, _replaceRawLog() {},
    _replaceArtifacts: (id, items) => { state.artifacts[id] = items; },
    _replaceTasks: (id, items) => { state.tasks[id] = items; },
    _setRunning: (id, value) => { state.running[id] = value; },
    _setForeground: (id, value) => { state.foreground[id] = value; },
    _updateApproval: (id, approvalId, status) => {
      state.events[id] = state.events[id].map((event) => event.data.kind === "approval" && event.data.approval.id === approvalId
        ? {...event, data: {...event.data, approval: {...event.data.approval, status}}} : event);
    },
    _setActiveAgentRun: (id, value) => { state.activeAgentRunIds[id] = value; },
    _replaceSessions: (items) => { state.sessions = items; },
    _upsertExternalSession: (item) => { state.sessions = [...state.sessions.filter((s) => s.id !== item.id), item]; },
    _shiftQueuedFollowUp: (id) => { state.queuedFollowUps[id]?.shift(); },
    _evictSessionView() {}, _replaceQueuedFollowUps: (id, items) => { state.queuedFollowUps[id] = items; },
    _addQueuedFollowUp: (id, item) => { if (!state.queuedFollowUps[id].some((queued) => queued.messageId === item.messageId)) state.queuedFollowUps[id].push(item); },
    _removeQueuedFollowUp: (id, messageId) => { state.queuedFollowUps[id] = state.queuedFollowUps[id].filter((item) => item.messageId !== messageId); },
    _setProviderCommands() {}, _bumpProviderCommands(id) { state.providerCommandRevisions[id] = (state.providerCommandRevisions[id] ?? 0) + 1; },
    _configureSession: (id, patch) => { Object.assign(session, patch); return session; }
  };
  const replies = {
    "projectRun.poll": () => { throw new Error("unknown method projectRun.poll"); },
    "session.send": { accepted: true, runId: "r" },
    "session.get": { session, messages: [] },
    "run.list": [{ id: "r", sessionId: "s", status: "running" }],
    "artifact.list": [], "event.subscribe": { subscriptionId: "sub" },
    "event.replay": { events: [], lastSequence: 0 }, "session.followUp.list": { items: [] }
  };
  // Model durable per-scope revisions for the real renderer projection path.
  const projectionStates = new Map();
  const projectRows = (scope, values, cursor) => {
    const previous = projectionStates.get(scope);
    const serialized = JSON.stringify(values);
    const revision = (previous?.revision ?? 0) + (previous?.serialized === serialized ? 0 : 1);
    const items = values.map((value, ordinal) => ({ value: cloneForIpc(value), order: { createdAt: value.createdAt ?? "2026-11-03T00:00:00Z", ordinal } }));
    const reset = !cursor || cursor.scope !== scope || cursor.epoch !== "fixture" || cursor.revision > revision
      || (previous && previous.items.some((item) => !values.some((value) => value.id === item.value.id)));
    const changes = reset ? items : cursor.revision === revision ? [] : items.filter((item) =>
      JSON.stringify(item) !== JSON.stringify(previous?.items.find((old) => old.value.id === item.value.id)));
    projectionStates.set(scope, { revision, serialized, items });
    return { cursor: { epoch: "fixture", scope, revision }, reset: Boolean(reset), items: changes };
  };
  const cloneForIpc = (value) => JSON.parse(JSON.stringify(value));
  replies["session.history"] = (params) => {
    const detail = typeof replies["session.get"] === "function" ? replies["session.get"](params) : replies["session.get"];
    return { session: cloneForIpc(detail.session), ...projectRows(`messages:session:${params.sessionId}`, detail.messages, params.cursor) };
  };
  replies["session.historyBatch"] = ({ items }) => ({ items: items.map((item) => replies["session.history"](item)) });
  replies["artifact.changes"] = (params) => {
    const values = typeof replies["artifact.list"] === "function" ? replies["artifact.list"](params) : replies["artifact.list"];
    return projectRows(params.sessionId ? `artifacts:session:${params.sessionId}` : `artifacts:projectRun:${params.projectRunId}`, values, params.cursor);
  };
  const bridge = {};
  const requestCore = (method, params) => {
    calls.push({ method, params, at: now });
    if (method === "event.wait" && !(method in replies)) return new Promise(() => {});
    return new Promise((resolve, reject) => setTimeout(() => {
      if (method === failMethod) { reject(new Error("simulated IPC failure")); return; }
      try { resolve(typeof replies[method] === "function" ? replies[method](params) : replies[method] ?? params); }
      catch (error) { reject(error); }
    }, ipcDelay));
  };
  const projectState = { projects: [{ id: "p" }], setActiveRun: (id, run) => { const p = projectState.projects.find((p) => p.id === id); if (p) p.activeRun = run; } };
  const modules = {
    ...helperModules,
    "./provider-ui": { applyLiveProviderUi() {} },
    "./bridge": { getBridge: () => bridgeAvailable ? bridge : undefined, requestCore },
    "./ui-motion": { markOutgoingMessage() {} },
    "./utils": { newId: (prefix) => `${prefix}-${nextMessage++}` },
    "./core-mappers": Object.fromEntries(["toDomainProject", "toDomainAgent", "toDomainTeam", "toStandaloneUiSession"].map((name) => [name, (value) => value])),
    "../stores/usage": { useUsageStore: { getState: () => ({ ingest() {} }) } },
    "../stores/sessions": { useSessionsStore: { getState: () => state } },
    "../stores/agents": { useAgentsStore: { getState: () => ({ instances }) } },
    "../stores/projects": { useProjectsStore: { getState: () => projectState } },
    "../stores/teams": { useTeamsStore: { getState: () => ({ teams: [team] }) } },
    "../stores/interactions": interactionsModule ?? { ingestInteractionEvents() {}, useInteractionsStore: { getState: () => ({ _removeSessions() {} }) } }
  };
  const exports = {};
  const optionalExports = (source.includes("function isAwaitingFirstOutput(") ? ", isAwaitingFirstOutput, projectRunAwaitingOutput" : "")
    + (source.includes("function needsStandalonePersistenceSync(") ? ", needsStandalonePersistenceSync" : "");
  const extraExports = `\nexport { pendingMessages, replaceSessionTimeline, sessionConfigWrites, toUiArtifact, sameArtifacts, syncProjectAndAgents, mergeStandaloneEvents, standaloneHydrated, standaloneMessageCache, standaloneEventCache, standaloneLastRebuildAt, scheduleStandaloneRender, clearSessionRuntime, schedulePoll, buildStandaloneTimeline, hydrateProjectRun, projectSessionBuilt, mergeEventCache, readSessionHistory, readArtifactHistory, persistedHistory, resetHistoryCapabilities, hydrateStandaloneSession, refreshStandaloneSessionState, readSessionHistoryBatch, standaloneSequences, projectSessionSequences, projectSessionEventCache, projectSessionDetails, consumeProjectPollFeed, projectEventCursors${optionalExports} };\nexport function setTestProjectHydrator(fn) { hydrateProjectRun = fn; }`;
  class FakeDate extends Date { static now() { return now; } }
  vm.runInNewContext(compile(source + extraExports), { exports, require: (name) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, Date: FakeDate, setTimeout, clearTimeout, window: { setTimeout }, console });
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const advance = async (ms) => {
    const end = now + ms;
    await flush();
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    now = end; await flush();
  };
  return { runtime: exports, state, projectState, session, instances, calls, renders, timers, replies, advance, setFailure: (method) => { failMethod = method; }, now: () => now };
}

export function delta(sequence, text = "Hello", overrides = {}) {
  return { schemaVersion: 1, eventId: `e${sequence}`, sequence, projectId: "p", sessionId: "s", runId: "r", timestamp: "2026-11-03T00:00:01Z", type: "agent.message_delta", payload: { messageId: "m", text }, ...overrides };
}
