import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useI18n } from "../../lib/i18n";
import { useConversationSelection } from "../../lib/use-conversation-selection";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { requestedWorkspaceFile } from "../../lib/workspace-state";
import { WorkspacePreview } from "./WorkspacePreview";
import { NewConversation } from "./NewConversation";
import { SessionWorkbench, type DrawerKind } from "./SessionWorkbench";
import { composerEase, flashComposer } from "./composer-motion";

export function SessionsPage({ active = true }: { active?: boolean }): JSX.Element {
  const { locale } = useI18n();
  const { session, openSession, loadingSession, missingSession, sessionLoadError, retrySession } = useConversationSelection(active);
  const workspace = useRef<HTMLDivElement>(null);
  const exitLayer = useRef<HTMLDivElement>(null);
  const composerOrigin = useRef<{ sessionId: string; rect: DOMRect; focused: boolean; exit: HTMLElement[] }>();
  const reducedMotion = useUiReducedMotion();
  const openCreatedSession = (id: string): void => {
    const page = workspace.current;
    const composer = page?.querySelector(".composer-box");
    if (page && composer) {
      const bounds = page.getBoundingClientRect();
      const exit = reducedMotion ? [] : Array.from(page.querySelectorAll<HTMLElement>(".new-conversation-backdrop, .new-conversation-welcome, .starter-launch"), element => {
        const rect = element.getBoundingClientRect();
        const copy = element.cloneNode(true) as HTMLElement;
        copy.inert = true;
        Object.assign(copy.style, { position: "absolute", left: `${rect.left - bounds.left}px`, top: `${rect.top - bounds.top}px`, width: `${rect.width}px`, margin: "0" });
        if (element.classList.contains("new-conversation-backdrop")) {
          // Keep the current light levels after the focused input unmounts.
          copy.style.height = `${rect.height}px`;
          for (const selector of [".new-conversation-skylight", ".new-conversation-spotlight"]) {
            const previous = element.querySelector<HTMLElement>(selector);
            const next = copy.querySelector<HTMLElement>(selector);
            if (previous && next) next.style.opacity = getComputedStyle(previous).opacity;
          }
        }
        return copy;
      });
      composerOrigin.current = { sessionId: id, rect: composer.getBoundingClientRect(), focused: composer.contains(document.activeElement), exit };
    }
    openSession(id);
  };
  useLayoutEffect(() => {
    const origin = composerOrigin.current;
    if (!origin || origin.sessionId !== session?.id) return;
    composerOrigin.current = undefined;
    const composer = workspace.current?.querySelector<HTMLElement>(".composer-box");
    if (!composer || !active) return;
    if (origin.focused) composer.querySelector("textarea")?.focus({ preventScroll: true });
    if (reducedMotion || !composer.animate) return;
    const rect = composer.getBoundingClientRect();
    if (!rect.width || !origin.rect.width) return;
    const layer = exitLayer.current;
    const outgoing = origin.exit.map(element => {
      const background = element.classList.contains("new-conversation-backdrop");
      if (background) workspace.current?.prepend(element);
      else layer?.append(element);
      const fade = background ? element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: "ease-out", fill: "both" }) : element.animate([
        { opacity: 1, transform: "translateY(0) scale(1)" },
        { opacity: 0, transform: "translateY(-14px) scale(.98)" }
      ], { duration: 180, easing: "ease-out", fill: "both" });
      fade.onfinish = () => element.remove();
      return fade;
    });
    flashComposer(composer, true);
    const animation = composer.animate([
      { transform: `translate(${origin.rect.left - rect.left}px, ${origin.rect.top - rect.top}px) scaleX(${origin.rect.width / rect.width})`, transformOrigin: "top left" },
      { transform: "translate(0, 0) scaleX(1)", transformOrigin: "top left" }
    ], { duration: 380, easing: composerEase });
    return () => {
      animation.cancel();
      outgoing.forEach(fade => fade.cancel());
      origin.exit.forEach(element => element.remove());
    };
  }, [session?.id, active, reducedMotion]);
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [preview, setPreview] = useState<{ sessionId: string; path: string }>();
  const openPreview = useCallback((path: string): void => {
    if (!session) return;
    setDrawer(null);
    setPreview({ sessionId: session.id, path });
  }, [session?.id]);
  const [showInspector, setShowInspector] = useState<boolean>();
  const previewPath = requestedWorkspaceFile(preview, session?.id);
  const inspectorOpen = !previewPath && (!drawer || drawer === "terminal" || drawer === "tools") && (showInspector ?? window.innerWidth >= 1500);
  const toggleInspector = useCallback((): void => {
    if (!inspectorOpen) {
      setPreview(undefined);
      setDrawer(current => current === "terminal" ? current : null);
    }
    setShowInspector(!inspectorOpen);
  }, [inspectorOpen]);
  const openDrawer = useCallback((next: DrawerKind): void => {
    setPreview(undefined);
    setDrawer(next);
  }, []);
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const panel = params.get("panel");
    if (!active || !session || params.get("session") !== session.id || (panel !== "browser" && panel !== "source-control")) return;
    openDrawer(panel);
    const next = new URLSearchParams(params); next.delete("panel"); setParams(next,{replace:true});
  },[active,session?.id,params,openDrawer,setParams]);
  const closeDrawer = useCallback((): void => setDrawer(null), []);
  const closePreview = useCallback((): void => setPreview(undefined), []);
  if (loadingSession || sessionLoadError) return <div className="flex h-full flex-col items-center justify-center gap-4 text-sm text-ink-2">
    <p role={sessionLoadError ? "alert" : "status"}>{sessionLoadError
      ? (locale === "zh-CN" ? "暂时打不开这个会话" : "Could not open this conversation")
      : (locale === "zh-CN" ? "正在打开会话…" : "Opening conversation…")}</p>
    {sessionLoadError && <button type="button" onClick={retrySession} className="rounded-lg border border-line px-4 py-2 text-ink hover:bg-panel">{locale === "zh-CN" ? "重试" : "Retry"}</button>}
  </div>;
  if (missingSession) return <div className="flex h-full flex-col items-center justify-center gap-4 text-sm text-ink-2"><p>{locale === "zh-CN" ? "此会话不存在或已移除" : "This conversation is unavailable"}</p><a href="#/sessions?new=1" className="rounded-lg border border-line px-4 py-2 text-ink hover:bg-panel">{locale === "zh-CN" ? "新会话" : "New conversation"}</a></div>;
  return (
    <div ref={workspace} className="relative isolate flex h-full min-h-0">
      {!session ? <NewConversation mode="code" onCreated={openCreatedSession} active={active} /> :
      <section className="relative z-[1] flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label={locale === "zh-CN" ? "对话" : "Conversation"}>
        <SessionWorkbench sessionId={session.id} focusKey={params.get("focus") ?? undefined} active={active} drawer={drawer} onOpenDrawer={openDrawer} onCloseDrawer={closeDrawer} onOpenSession={openSession} onToggleInspector={toggleInspector} inspectorOpen={inspectorOpen} onOpenLocalFile={openPreview} />
      </section>}

      {session && previewPath && <WorkspacePreview key={session.id} sessionId={session.id} path={previewPath} onClose={closePreview} />}
      <div ref={exitLayer} className="new-conversation-exit" aria-hidden="true" />
    </div>
  );
}
