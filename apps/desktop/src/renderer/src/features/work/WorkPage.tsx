import { useEffect, useMemo, useState } from "react";
import { Briefcase } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { NewSessionDialog } from "../sessions/NewSessionDialog";
import { SessionListPanel } from "../sessions/SessionListPanel";
import { SessionWorkbench, type DrawerKind } from "../sessions/SessionWorkbench";
import { useSessionsStore } from "../../stores/sessions";
import { toast } from "../../stores/toast";
import { deleteWorkbenchSession } from "../../lib/orchestration-runtime";
import { WorkPreviewPane } from "./WorkPreviewPane";

/**
 * Work mode: office deliverables. Chat on the left/center (same workbench as
 * Code mode), live artifact preview on the right. No git, diffs or checkpoints.
 */
export function WorkPage({ active = true }: { active?: boolean }): JSX.Element {
  const { t } = useI18n();
  const allSessions = useSessionsStore((state) => state.sessions);
  // Filter in useMemo, not in the selector (fresh array identity per store
  // update would re-render the page on every streaming token).
  const sessions = useMemo(() => allSessions.filter((session) => session.mode === "work"), [allSessions]);
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

  // Default to the most recent work session. Both workbenches stay mounted
  // (keep-alive); only the visible page may claim the shared activeSessionId.
  useEffect(() => {
    if (!active) return;
    if ((!activeSessionId || !activeSession) && sessions.length > 0) {
      const latest = [...sessions].sort((a, b) =>
        (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt)
      )[0];
      setActiveSession(latest.id);
    }
  }, [active, activeSessionId, activeSession, sessions, setActiveSession]);

  if (sessions.length === 0) {
    return (
      <div className="relative flex h-full items-center justify-center p-8">
        <EmptyState
          icon={Briefcase}
          title={t("work.empty.title")}
          description={t("work.empty.desc")}
          action={
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              {t("work.empty.action")}
            </Button>
          }
        />
        <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} onCreated={setActiveSession} mode="work" />
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0">
      <SessionListPanel
        mode="work"
        activeSessionId={activeSessionId}
        onSelect={setActiveSession}
        onNew={() => setNewOpen(true)}
        onDelete={(session) => setSessionToDelete(session.id)}
      />

      <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label={t("work.title")}>
        {activeSession ? (
          <SessionWorkbench
            mode="work"
            sessionId={activeSession.id}
            active={active}
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

      {activeSession && (
        <aside className="flex w-[42%] max-w-2xl shrink-0 flex-col border-l border-line/80 bg-panel/60 backdrop-blur-xl" aria-label={t("work.preview.title")}>
          <WorkPreviewPane sessionId={activeSession.id} />
        </aside>
      )}

      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} onCreated={setActiveSession} mode="work" />
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
