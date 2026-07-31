import { useEffect, useMemo, useState } from "react";
import { MessagesSquare } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { AgentPanel } from "./AgentPanel";
import { NewSessionDialog } from "./NewSessionDialog";
import { SessionListPanel } from "./SessionListPanel";
import { SessionWorkbench, type DrawerKind } from "./SessionWorkbench";
import { useSessionsStore } from "../../stores/sessions";
import { toast } from "../../stores/toast";
import { deleteWorkbenchSession } from "../../lib/orchestration-runtime";
import { ModeSwitch } from "../work/ModeSwitch";

export function SessionsPage(): JSX.Element {
  const { t } = useI18n();
  const allSessions = useSessionsStore((state) => state.sessions);
  // Filter in useMemo, not in the selector: a filtered array is a fresh
  // reference per store update and would re-render the page on every token.
  const sessions = useMemo(() => allSessions.filter((session) => (session.mode ?? "code") === "code"), [allSessions]);
  const activeSessionId = useSessionsStore((state) => state.activeSessionId);
  const setActiveSession = useSessionsStore((state) => state.setActiveSession);

  const [newOpen, setNewOpen] = useState(false);
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [sessionToDelete, setSessionToDelete] = useState<string>();
  const [deleting, setDeleting] = useState(false);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const deletingSession = sessions.find((session) => session.id === sessionToDelete);

  const handleDelete = async (): Promise<void> => {
    if (!deletingSession) return;
    setDeleting(true);
    try {
      await deleteWorkbenchSession(deletingSession.id);
      setSessionToDelete(undefined);
      toast.info(t("sessions.deletedToast", { name: deletingSession.title || t("sessions.header.untitled") }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  // Default to the most recent session so chat is the entry point (F-023).
  useEffect(() => {
    if ((!activeSessionId || !activeSession) && sessions.length > 0) {
      const latest = [...sessions].sort((a, b) =>
        (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt)
      )[0];
      setActiveSession(latest.id);
    }
  }, [activeSessionId, activeSession, sessions, setActiveSession]);

  const header = <ModeSwitch mode="code" />;

  if (sessions.length === 0) {
    return (
      <div className="relative flex h-full items-center justify-center p-8">
        <div className="absolute left-1/2 top-3 -translate-x-1/2">{header}</div>
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
    <div className="relative flex h-full min-h-0">
      <SessionListPanel
        mode="code"
        activeSessionId={activeSessionId}
        onSelect={setActiveSession}
        onNew={() => setNewOpen(true)}
        onDelete={(session) => setSessionToDelete(session.id)}
      />

      <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label={t("sessions.title")}>
        {activeSession ? (
          <SessionWorkbench
            sessionId={activeSession.id}
            drawer={drawer}
            onOpenDrawer={setDrawer}
            onCloseDrawer={() => setDrawer(null)}
            onOpenSession={setActiveSession}
            headerActions={header}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-ink-3">
            {t("sessions.noSelection")}
          </div>
        )}
      </section>

      <AgentPanel session={activeSession} onOpenSession={setActiveSession} />

      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} onCreated={setActiveSession} />
      <Dialog
        open={Boolean(deletingSession)}
        onOpenChange={(open) => { if (!open && !deleting) setSessionToDelete(undefined); }}
        title={t("sessions.deleteTitle")}
        description={t("sessions.deleteDesc", { name: deletingSession?.title || t("sessions.header.untitled") })}
        footer={
          <>
            <Button variant="outline" onClick={() => setSessionToDelete(undefined)} disabled={deleting}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? t("sessions.deleting") : t("sessions.delete")}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-ink-2">{t("sessions.deleteHint")}</p>
      </Dialog>
    </div>
  );
}
