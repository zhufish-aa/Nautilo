import { useEffect, useRef, useState } from "react";
import { GitFork, MessagesSquare, Package, SquareTerminal } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { TimelineEventView } from "../timeline/Timeline";
import { StatusChip } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { AgentPanel } from "./AgentPanel";
import { Composer } from "./Composer";
import { ArtifactsDrawer, DagDrawer, TerminalDrawer } from "./Drawers";
import { NewSessionDialog } from "./NewSessionDialog";
import { RunActivityIndicator } from "./RunActivityIndicator";
import { SessionListPanel, sessionTargetName } from "./SessionListPanel";
import { useSessionsStore } from "../../stores/sessions";
import { useProjectsStore } from "../../stores/projects";
import { useTeamsStore } from "../../stores/teams";
import { useAgentsStore } from "../../stores/agents";

type DrawerKind = "terminal" | "artifacts" | "dag" | null;

export function SessionsPage(): JSX.Element {
  const { t } = useI18n();
  const sessions = useSessionsStore((state) => state.sessions);
  const activeSessionId = useSessionsStore((state) => state.activeSessionId);
  const setActiveSession = useSessionsStore((state) => state.setActiveSession);

  const [newOpen, setNewOpen] = useState(false);
  const [drawer, setDrawer] = useState<DrawerKind>(null);

  const activeSession = sessions.find((session) => session.id === activeSessionId);

  // Default to the most recent session so chat is the entry point (F-023).
  useEffect(() => {
    if (!activeSessionId && sessions.length > 0) {
      const latest = [...sessions].sort((a, b) =>
        (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt)
      )[0];
      setActiveSession(latest.id);
    }
  }, [activeSessionId, sessions, setActiveSession]);

  if (sessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          icon={MessagesSquare}
          title={t("sessions.empty.title")}
          description={t("sessions.empty.desc")}
          action={
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              {t("sessions.empty.action")}
            </Button>
          }
        />
        <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} onCreated={setActiveSession} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <SessionListPanel activeSessionId={activeSessionId} onSelect={setActiveSession} onNew={() => setNewOpen(true)} />

      <section className="flex min-w-0 flex-1 flex-col" aria-label={t("sessions.title")}>
        {activeSession ? (
          <ChatArea
            sessionId={activeSession.id}
            drawer={drawer}
            onOpenDrawer={setDrawer}
            onCloseDrawer={() => setDrawer(null)}
            onOpenSession={setActiveSession}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-ink-3">
            {t("sessions.noSelection")}
          </div>
        )}
      </section>

      <AgentPanel session={activeSession} onOpenSession={setActiveSession} />

      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} onCreated={setActiveSession} />
    </div>
  );
}

function ChatArea({
  sessionId,
  drawer,
  onOpenDrawer,
  onCloseDrawer,
  onOpenSession
}: {
  sessionId: string;
  drawer: DrawerKind;
  onOpenDrawer: (drawer: DrawerKind) => void;
  onCloseDrawer: () => void;
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const session = useSessionsStore((state) => state.sessions.find((item) => item.id === sessionId));
  const events = useSessionsStore((state) => state.events[sessionId] ?? []);
  const tasks = useSessionsStore((state) => state.tasks[sessionId] ?? []);
  const foregroundLifecycle = useSessionsStore((state) => state.foreground[sessionId]);
  const teams = useTeamsStore((state) => state.teams);
  const instances = useAgentsStore((state) => state.instances);
  const projects = useProjectsStore((state) => state.projects);

  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const lastEventId = events[events.length - 1]?.id;

  useEffect(() => {
    if (nearBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [lastEventId]);

  useEffect(() => {
    nearBottomRef.current = true;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [sessionId]);

  if (!session) return <div className="flex-1" />;

  const foregroundRunning = foregroundLifecycle?.status === "running" || foregroundLifecycle?.status === "waiting_approval";
  const project = projects.find((item) => item.id === session.projectId);
  const targetName = sessionTargetName(session, teams, instances);
  const hasPlan = tasks.length > 0;

  return (
    <>
      <header className="flex items-center justify-between gap-3 border-b border-line bg-panel px-5 py-3 backdrop-blur-xl">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold text-ink">{session.title || t("sessions.header.untitled")}</h1>
            <StatusChip
              tone={session.status === "running" ? "accent" : session.status === "waiting_approval" ? "warn" : session.status === "failed" ? "danger" : "muted"}
              label={t(`sessions.status.${session.status}` as MessageKey)}
              pulse={session.status === "running"}
            />
          </div>
          <p className="mt-0.5 truncate text-xs text-ink-3">
            {project?.name} · {targetName}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {hasPlan && (
            <Button variant="ghost" size="sm" onClick={() => onOpenDrawer("dag")}>
              <GitFork className="h-4 w-4" aria-hidden />
              {t("sessions.header.dag")}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => onOpenDrawer("artifacts")}>
            <Package className="h-4 w-4" aria-hidden />
            {t("sessions.header.artifacts")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onOpenDrawer("terminal")}>
            <SquareTerminal className="h-4 w-4" aria-hidden />
            {t("sessions.header.terminal")}
          </Button>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
        aria-live="polite"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-5 py-6">
          {events.map((event) => (
            <TimelineEventView
              key={event.id}
              event={event}
              onViewDiff={() => onOpenDrawer("artifacts")}
              onOpenSession={onOpenSession}
            />
          ))}
          <RunActivityIndicator lifecycle={foregroundLifecycle} events={events} />
          {events.length === 0 && (
            <p className="py-16 text-center text-sm text-ink-3">{t("sessions.noSelection")}</p>
          )}
        </div>
      </div>

      <Composer
        sessionId={sessionId}
        targetName={targetName}
        running={foregroundRunning}
        disabled={session.status === "archived"}
      />

      <TerminalDrawer open={drawer === "terminal"} onClose={onCloseDrawer} sessionId={sessionId} />
      <ArtifactsDrawer open={drawer === "artifacts"} onClose={onCloseDrawer} sessionId={sessionId} />
      <DagDrawer open={drawer === "dag"} onClose={onCloseDrawer} tasks={tasks} />
    </>
  );
}
