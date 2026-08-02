import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Briefcase, PanelRightClose, PanelRightOpen } from "lucide-react";
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
import { cn } from "../../lib/utils";
import { WorkPreviewPane } from "./WorkPreviewPane";

const MIN_PREVIEW_WIDTH = 320;
const MIN_WORKBENCH_WIDTH = 360;

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
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [previewWidth, setPreviewWidth] = useState<number>();
  const [isResizingPreview, setIsResizingPreview] = useState(false);
  const workAreaRef = useRef<HTMLDivElement>(null);
  const workbenchRef = useRef<HTMLElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const resizeStartRef = useRef<{ x: number; width: number }>();
  // File the chat timeline asked the preview pane to show (click on a
  // Markdown link / chip / artifact / file_change row). Session-scoped so
  // keep-alive workbenches never leak a path across sessions.
  const [requestedPreviewPath, setRequestedPreviewPath] = useState<string>();

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const deletingSession = sessions.find((session) => session.id === sessionToDelete);

  // Stable callback: Timeline rows memoized on event identity must never see
  // a changing dispatcher.
  const handleOpenLocalFile = useCallback((path: string): void => {
    setRequestedPreviewPath(path);
  }, []);

  const maxPreviewWidth = useCallback((): number => {
    const workbenchWidth = workbenchRef.current?.clientWidth;
    const previewWidth = previewRef.current?.getBoundingClientRect().width;
    if (workbenchWidth && previewWidth) {
      // Keep the chat workbench usable as the preview grows; the session list
      // is outside this calculation and therefore never gets squeezed.
      return Math.max(MIN_PREVIEW_WIDTH, workbenchWidth + previewWidth - MIN_WORKBENCH_WIDTH);
    }
    const available = workAreaRef.current?.clientWidth ?? window.innerWidth;
    return Math.max(MIN_PREVIEW_WIDTH, available - MIN_WORKBENCH_WIDTH);
  }, []);

  const constrainPreviewWidth = useCallback((width: number): number => {
    return Math.min(Math.max(width, MIN_PREVIEW_WIDTH), maxPreviewWidth());
  }, [maxPreviewWidth]);

  const beginPreviewResize = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    if (previewCollapsed) return;
    const width = previewRef.current?.getBoundingClientRect().width;
    if (!width) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStartRef.current = { x: event.clientX, width };
    setIsResizingPreview(true);
  }, [previewCollapsed]);

  const resizePreview = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    const start = resizeStartRef.current;
    if (!start) return;
    // The preview is anchored on the right: dragging left makes it wider.
    setPreviewWidth(constrainPreviewWidth(start.width + start.x - event.clientX));
  }, [constrainPreviewWidth]);

  const endPreviewResize = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    resizeStartRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setIsResizingPreview(false);
  }, []);

  const adjustPreviewWidth = useCallback((delta: number): void => {
    const currentWidth = previewRef.current?.getBoundingClientRect().width ?? previewWidth ?? MIN_PREVIEW_WIDTH;
    setPreviewWidth(constrainPreviewWidth(currentWidth + delta));
  }, [constrainPreviewWidth, previewWidth]);

  const handleResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      adjustPreviewWidth(40);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      adjustPreviewWidth(-40);
    }
  }, [adjustPreviewWidth]);

  useEffect(() => {
    if (!isResizingPreview) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isResizingPreview]);

  // Clear the pending request when the visible session changes.
  useEffect(() => {
    setRequestedPreviewPath(undefined);
  }, [activeSession?.id]);

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
    <div ref={workAreaRef} className="relative flex h-full min-h-0">
      <SessionListPanel
        mode="work"
        activeSessionId={activeSessionId}
        onSelect={setActiveSession}
        onNew={() => setNewOpen(true)}
        onDelete={(session) => setSessionToDelete(session.id)}
      />

      <section ref={workbenchRef} className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label={t("work.title")}>
        {activeSession ? (
          <SessionWorkbench
            mode="work"
            sessionId={activeSession.id}
            active={active}
            drawer={drawer}
            onOpenDrawer={setDrawer}
            onCloseDrawer={() => setDrawer(null)}
            onOpenSession={setActiveSession}
            onOpenLocalFile={handleOpenLocalFile}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-ink-3">
            {t("sessions.noSelection")}
          </div>
        )}
      </section>

      {activeSession && (
        <aside
          ref={previewRef}
          className={cn(
            "relative flex shrink-0 flex-col overflow-hidden border-l border-line/80 bg-panel/60 backdrop-blur-xl transition-[width] duration-200 ease-out",
            previewCollapsed ? "w-10" : previewWidth ? "max-w-none" : "w-[42%] max-w-2xl",
            isResizingPreview && "transition-none"
          )}
          style={!previewCollapsed && previewWidth ? { width: `${previewWidth}px` } : undefined}
          aria-label={t("work.preview.title")}
        >
          {!previewCollapsed && (
            <div
              role="separator"
              tabIndex={0}
              aria-label={t("work.preview.resize")}
              aria-orientation="vertical"
              aria-valuemin={MIN_PREVIEW_WIDTH}
              aria-valuemax={maxPreviewWidth()}
              aria-valuenow={Math.round(previewRef.current?.getBoundingClientRect().width ?? previewWidth ?? 0)}
              title={t("work.preview.resize")}
              onPointerDown={beginPreviewResize}
              onPointerMove={resizePreview}
              onPointerUp={endPreviewResize}
              onPointerCancel={endPreviewResize}
              onKeyDown={handleResizeKeyDown}
              className="group absolute inset-y-0 left-0 z-20 w-3 -translate-x-1/2 cursor-col-resize touch-none outline-none"
            >
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-accent group-focus-visible:bg-accent" />
            </div>
          )}
          <button
            type="button"
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center text-ink-3 transition-colors hover:bg-card-hover hover:text-ink",
              !previewCollapsed && "self-start"
            )}
            onClick={() => setPreviewCollapsed((collapsed) => !collapsed)}
            aria-label={t(previewCollapsed ? "work.preview.expand" : "work.preview.collapse")}
            title={t(previewCollapsed ? "work.preview.expand" : "work.preview.collapse")}
          >
            {previewCollapsed ? <PanelRightOpen className="h-4 w-4" aria-hidden /> : <PanelRightClose className="h-4 w-4" aria-hidden />}
          </button>
          <div className={cn("min-h-0 min-w-0 flex-1", previewCollapsed && "hidden")}>
            <WorkPreviewPane sessionId={activeSession.id} requestedPath={requestedPreviewPath} />
          </div>
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
