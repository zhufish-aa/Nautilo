import { create } from "zustand";
import type { Session as DomainSession } from "@agenthub/domain";
import { getBridge, requestCore } from "../lib/bridge";
import { newId } from "../lib/utils";
import type {
  ContextUsage,
  RunLifecycle,
  SessionArtifact,
  SessionCheckpoint,
  SessionTask,
  SessionTarget,
  TimelineEvent,
  TimelinePayload,
  UiSession
} from "../lib/types";

/**
 * Sessions store: the append-only event log is the single source of truth.
 * Every event gets a monotonic per-session sequence; the runner keeps appending
 * even when the workbench is unmounted, and the UI resyncs by re-reading the
 * log — the same replay contract the real event bus will use (F-036, S-010).
 */
interface SessionsState {
  sessions: UiSession[];
  events: Record<string, TimelineEvent[]>;
  tasks: Record<string, SessionTask[]>;
  artifacts: Record<string, SessionArtifact[]>;
  rawLog: Record<string, string[]>;
  contextUsage: Record<string, ContextUsage | undefined>;
  checkpoints: Record<string, SessionCheckpoint[]>;
  /** The provider turn currently occupying this exact session. */
  foreground: Record<string, RunLifecycle | undefined>;
  running: Record<string, RunLifecycle | undefined>;
  activeAgentRunIds: Record<string, string | undefined>;
  activeSessionId?: string;
  editingMessage?: { sessionId: string; messageId: string; text: string };

  setActiveSession: (id: string | undefined) => void;
  removeSessions: (sessionIds: string[]) => void;
  startEditingMessage: (sessionId: string, messageId: string, text: string) => void;
  cancelEditingMessage: () => void;
  createSession: (input: {
    projectId: string;
    target: SessionTarget;
    title: string;
    model?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    parentSessionId?: string;
    runId?: string;
  }) => UiSession;
  /** Runner-facing mutators (prefixed; UI components should not call these). */
  _append: (sessionId: string, payload: TimelinePayload) => TimelineEvent;
  _patchEvent: (sessionId: string, eventId: string, patch: Partial<TimelinePayload>) => void;
  _setRunning: (sessionId: string, run: RunLifecycle | undefined) => void;
  _setForeground: (sessionId: string, run: RunLifecycle | undefined) => void;
  _setActiveAgentRun: (sessionId: string, runId: string | undefined) => void;
  _configureSession: (sessionId: string, patch: Pick<Partial<UiSession>, "title" | "model" | "reasoningEffort" | "serviceTier" | "permissionMode">) => UiSession | undefined;
  /** Rebinds an agent-targeted session to another instance of the same provider, resetting model overrides. */
  _setSessionInstance: (sessionId: string, instanceId: string) => UiSession | undefined;
  _upsertTask: (sessionId: string, task: SessionTask) => void;
  _appendRaw: (sessionId: string, lines: string[]) => void;
  _updateApproval: (
    sessionId: string,
    approvalId: string,
    decision: "approved" | "rejected"
  ) => void;
  _addArtifact: (sessionId: string, artifact: SessionArtifact) => void;
  _upsertExternalSession: (session: UiSession) => void;
  _replaceEvents: (sessionId: string, events: TimelineEvent[]) => void;
  _replaceTasks: (sessionId: string, tasks: SessionTask[]) => void;
  _replaceArtifacts: (sessionId: string, artifacts: SessionArtifact[]) => void;
  _replaceRawLog: (sessionId: string, lines: string[]) => void;
  _replaceContextUsage: (sessionId: string, usage: ContextUsage | undefined) => void;
  _replaceCheckpoints: (sessionId: string, checkpoints: SessionCheckpoint[]) => void;
  _replaceSessions: (sessions: UiSession[]) => void;
}

function buildInitial(): Pick<
  SessionsState,
  "sessions" | "events" | "tasks" | "artifacts" | "rawLog" | "contextUsage" | "checkpoints"
> {
  return {
    sessions: [],
    events: {},
    tasks: {},
    artifacts: {},
    rawLog: {},
    contextUsage: {},
    checkpoints: {}
  };
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
      ...buildInitial(),
      running: {},
      foreground: {},
      activeAgentRunIds: {},
      activeSessionId: undefined,
      editingMessage: undefined,

      setActiveSession: (id) =>
        set((state) => ({
          activeSessionId: id,
          editingMessage: state.editingMessage?.sessionId === id ? state.editingMessage : undefined,
          sessions: state.sessions.map((session) =>
            session.id === id ? { ...session, unreadCount: 0 } : session
          )
        })),

      removeSessions: (sessionIds) =>
        set((state) => {
          const deleted = new Set(sessionIds);
          const sessions = state.sessions.filter((session) => !deleted.has(session.id));
          const keep = <T,>(values: Record<string, T>): Record<string, T> =>
            Object.fromEntries(Object.entries(values).filter(([id]) => !deleted.has(id))) as Record<string, T>;
          const nextActive = state.activeSessionId && !deleted.has(state.activeSessionId)
            ? state.activeSessionId
            : [...sessions].sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt))[0]?.id;
          return {
            sessions,
            activeSessionId: nextActive,
            editingMessage: state.editingMessage && !deleted.has(state.editingMessage.sessionId) ? state.editingMessage : undefined,
            events: keep(state.events),
            tasks: keep(state.tasks),
            artifacts: keep(state.artifacts),
            rawLog: keep(state.rawLog),
            contextUsage: keep(state.contextUsage),
            checkpoints: keep(state.checkpoints),
            foreground: keep(state.foreground),
            running: keep(state.running),
            activeAgentRunIds: keep(state.activeAgentRunIds)
          };
        }),

      startEditingMessage: (sessionId, messageId, text) => set({ editingMessage: { sessionId, messageId, text } }),
      cancelEditingMessage: () => set({ editingMessage: undefined }),

      createSession: ({ projectId, target, title, model, reasoningEffort, serviceTier, parentSessionId, runId }) => {
        const now = new Date().toISOString();
        const session: UiSession = {
          id: newId("sess"),
          projectId,
          target,
          title,
          model,
          reasoningEffort,
          serviceTier,
          status: "idle",
          parentSessionId,
          runId,
          unreadCount: 0,
          createdAt: now,
          updatedAt: now
        };
        set((state) => ({
          sessions: [session, ...state.sessions],
          events: { ...state.events, [session.id]: [] },
          tasks: { ...state.tasks, [session.id]: [] },
          artifacts: { ...state.artifacts, [session.id]: [] },
          rawLog: { ...state.rawLog, [session.id]: [] }
        }));
        if (getBridge()) {
          const memberId = target.type === "member" ? target.memberId : target.type === "agent" ? target.instanceId : "";
          const domainSession: DomainSession = {
            id: session.id,
            projectId,
            memberId,
            teamId: target.teamId,
            parentSessionId,
            agentInstanceId: target.type === "agent" ? target.instanceId : undefined,
            title,
            model,
            reasoningEffort,
            serviceTier,
            status: "idle",
            unreadCount: 0,
            createdAt: now,
            updatedAt: now
          };
          void requestCore<DomainSession>("session.upsert", domainSession).catch((error) => console.error("Failed to persist session", error));
        }
        return session;
      },

      _append: (sessionId, payload) => {
        const state = get();
        const log = state.events[sessionId] ?? [];
        const event: TimelineEvent = {
          id: newId("ev"),
          sessionId,
          sequence: (log[log.length - 1]?.sequence ?? 0) + 1,
          timestamp: new Date().toISOString(),
          data: payload
        };
        set((current) => ({
          events: { ...current.events, [sessionId]: [...(current.events[sessionId] ?? []), event] },
          sessions: current.sessions.map((session) =>
            session.id === sessionId
              ? {
                  ...session,
                  lastMessageAt: event.timestamp,
                  updatedAt: event.timestamp,
                  unreadCount:
                    current.activeSessionId === sessionId
                      ? session.unreadCount
                      : session.unreadCount + 1
                }
              : session
          )
        }));
        return event;
      },

      _patchEvent: (sessionId, eventId, patch) =>
        set((state) => ({
          events: {
            ...state.events,
            [sessionId]: (state.events[sessionId] ?? []).map((event) =>
              event.id === eventId
                ? { ...event, data: { ...event.data, ...patch } as TimelinePayload }
                : event
            )
          }
        })),

      _setRunning: (sessionId, run) =>
        set((state) => ({
          // Project/orchestration lifecycle is background state. Session status
          // is hydrated from the Core Daemon and must describe only the CLI run
          // attached to that session; a running child must not lock its parent.
          running: { ...state.running, [sessionId]: run }
        })),

      _setForeground: (sessionId, run) =>
        set((state) => ({
          foreground: { ...state.foreground, [sessionId]: run }
        })),

      _setActiveAgentRun: (sessionId, runId) =>
        set((state) => ({
          activeAgentRunIds: { ...state.activeAgentRunIds, [sessionId]: runId }
        })),

      _configureSession: (sessionId, patch) => {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session) return undefined;
        const updated = { ...session, ...patch, updatedAt: new Date().toISOString() };
        set((state) => ({
          sessions: state.sessions.map((item) => item.id === sessionId ? updated : item)
        }));
        return updated;
      },

      _setSessionInstance: (sessionId, instanceId) => {
        const session = get().sessions.find((item) => item.id === sessionId);
        if (!session || session.target.type !== "agent") return undefined;
        const updated: UiSession = {
          ...session,
          target: { ...session.target, instanceId },
          // Model overrides belong to the previous instance's catalog; clear
          // them so the new instance's defaults apply.
          model: undefined,
          reasoningEffort: undefined,
          serviceTier: undefined,
          updatedAt: new Date().toISOString()
        };
        set((state) => ({
          sessions: state.sessions.map((item) => item.id === sessionId ? updated : item)
        }));
        return updated;
      },

      _upsertTask: (sessionId, task) =>
        set((state) => {
          const list = state.tasks[sessionId] ?? [];
          const index = list.findIndex((item) => item.id === task.id);
          const next =
            index >= 0 ? list.map((item) => (item.id === task.id ? task : item)) : [...list, task];
          return { tasks: { ...state.tasks, [sessionId]: next } };
        }),

      _appendRaw: (sessionId, lines) =>
        set((state) => ({
          rawLog: { ...state.rawLog, [sessionId]: [...(state.rawLog[sessionId] ?? []), ...lines] }
        })),

      _updateApproval: (sessionId, approvalId, decision) =>
        set((state) => ({
          events: {
            ...state.events,
            [sessionId]: (state.events[sessionId] ?? []).map((event) =>
              event.data.kind === "approval" && event.data.approval.id === approvalId
                ? {
                    ...event,
                    data: {
                      ...event.data,
                      approval: { ...event.data.approval, status: decision }
                    }
                  }
                : event
            )
          }
        })),

      _addArtifact: (sessionId, artifact) =>
        set((state) => ({
          artifacts: {
            ...state.artifacts,
            [sessionId]: [...(state.artifacts[sessionId] ?? []), artifact]
          }
        })),

      _upsertExternalSession: (session) =>
        set((state) => {
          const exists = state.sessions.some((item) => item.id === session.id);
          return {
            sessions: exists
              ? state.sessions.map((item) => item.id === session.id ? { ...item, ...session } : item)
              : [session, ...state.sessions],
            events: state.events[session.id] ? state.events : { ...state.events, [session.id]: [] },
            tasks: state.tasks[session.id] ? state.tasks : { ...state.tasks, [session.id]: [] },
            artifacts: state.artifacts[session.id] ? state.artifacts : { ...state.artifacts, [session.id]: [] },
            rawLog: state.rawLog[session.id] ? state.rawLog : { ...state.rawLog, [session.id]: [] }
          };
        }),

      _replaceEvents: (sessionId, events) =>
        set((state) => ({ events: { ...state.events, [sessionId]: events } })),

      _replaceTasks: (sessionId, tasks) =>
        set((state) => ({ tasks: { ...state.tasks, [sessionId]: tasks } })),

      _replaceArtifacts: (sessionId, artifacts) =>
        set((state) => ({ artifacts: { ...state.artifacts, [sessionId]: artifacts } })),

      _replaceRawLog: (sessionId, lines) =>
        set((state) => ({ rawLog: { ...state.rawLog, [sessionId]: lines } })),

      _replaceContextUsage: (sessionId, usage) =>
        set((state) => ({ contextUsage: { ...state.contextUsage, [sessionId]: usage } })),

      _replaceCheckpoints: (sessionId, checkpoints) =>
        set((state) => ({ checkpoints: { ...state.checkpoints, [sessionId]: checkpoints } })),

      _replaceSessions: (sessions) => set((state) => {
        const ids = new Set(sessions.map((session) => session.id));
        return {
          sessions,
          activeSessionId: state.activeSessionId && ids.has(state.activeSessionId) ? state.activeSessionId : undefined,
          events: Object.fromEntries(sessions.map((session) => [session.id, state.events[session.id] ?? []])),
          tasks: Object.fromEntries(sessions.map((session) => [session.id, state.tasks[session.id] ?? []])),
          artifacts: Object.fromEntries(sessions.map((session) => [session.id, state.artifacts[session.id] ?? []])),
          rawLog: Object.fromEntries(sessions.map((session) => [session.id, state.rawLog[session.id] ?? []])),
          contextUsage: Object.fromEntries(sessions.map((session) => [session.id, state.contextUsage[session.id]])),
          checkpoints: Object.fromEntries(sessions.map((session) => [session.id, state.checkpoints[session.id] ?? []])),
          foreground: Object.fromEntries(sessions.map((session) => [session.id, state.foreground[session.id]]))
        };
      })
}));
