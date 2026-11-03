import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { useConversationSelection } from "../../lib/use-conversation-selection";
import { requestedWorkspaceFile } from "../../lib/workspace-state";
import { WorkspacePreview } from "./WorkspacePreview";
import { AgentPanel } from "./AgentPanel";
import { NewConversation } from "./NewConversation";
import { SessionWorkbench, type DrawerKind } from "./SessionWorkbench";

export function SessionsPage({ active = true }: { active?: boolean }): JSX.Element {
  const { locale } = useI18n();
  const { session, openSession, missingSession } = useConversationSelection(active);
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [preview, setPreview] = useState<{ sessionId: string; path: string }>();
  const openPreview = useCallback((path: string): void => {
    if (!session) return;
    setDrawer(null);
    setShowAgents(false);
    setPreview({ sessionId: session.id, path });
  }, [session?.id]);
  const [showAgents, setShowAgents] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const closeAgents = useCallback((): void => { setShowAgents(false); trigger.current?.focus(); }, []);
  const toggleAgents = useCallback((): void => {
    if (showAgents) { closeAgents(); return; }
    trigger.current = document.activeElement as HTMLElement;
    setPreview(undefined);
    setShowAgents(true);
  }, [showAgents, closeAgents]);
  const openDrawer = useCallback((next: DrawerKind): void => { setPreview(undefined); setDrawer(next); }, []);
  const closeDrawer = useCallback((): void => setDrawer(null), []);
  const closePreview = useCallback((): void => setPreview(undefined), []);
  useEffect(() => {
    if (!showAgents || !active) return;
    closeButton.current?.focus();
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { setShowAgents(false); trigger.current?.focus(); }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [showAgents, active]);
  const previewPath = requestedWorkspaceFile(preview, session?.id);
  if (missingSession) return <div className="flex h-full flex-col items-center justify-center gap-4 text-sm text-ink-2"><p>{locale === "zh-CN" ? "此会话不存在或已移除" : "This conversation is unavailable"}</p><a href="#/sessions?new=1" className="rounded-lg border border-line px-4 py-2 text-ink hover:bg-panel">{locale === "zh-CN" ? "新会话" : "New conversation"}</a></div>;
  if (!session) return <NewConversation mode="code" onCreated={openSession} />;
  return (
    <div className="relative flex h-full min-h-0">
      <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label={locale === "zh-CN" ? "对话" : "Conversation"}>
        <SessionWorkbench sessionId={session.id} active={active} drawer={drawer} onOpenDrawer={openDrawer} onCloseDrawer={closeDrawer} onOpenSession={openSession} onToggleAgents={toggleAgents} agentsOpen={showAgents} onOpenLocalFile={openPreview} />
      </section>

      {previewPath && <WorkspacePreview key={session.id} sessionId={session.id} path={previewPath} onClose={closePreview} />}
      {showAgents && <div className="agent-panel-overlay relative flex h-full shrink-0 flex-col"><div className="flex h-12 shrink-0 items-center justify-end px-3"><button ref={closeButton} type="button" aria-label={locale === "zh-CN" ? "关闭团队" : "Close team"} onClick={closeAgents} className="rounded-lg p-2 text-ink-3 hover:bg-card-hover focus-visible:ring-2 focus-visible:ring-accent"><X className="h-4 w-4" /></button></div><AgentPanel session={session} onOpenSession={openSession} /></div>}
    </div>
  );
}
