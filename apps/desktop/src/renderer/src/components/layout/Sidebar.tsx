import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { FileText, Folder, PanelLeftClose, Plus, Search, Settings } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { searchSidebarSessions, sessionLocation } from "../../lib/sidebar-navigation";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { deleteWorkbenchSession } from "../../lib/orchestration-runtime";
import { toast } from "../../stores/toast";
import type { UiSession } from "../../lib/types";
import { SessionListPanel } from "../../features/sessions/SessionListPanel";
import { AddProjectDialog } from "../../features/projects/AddProjectDialog";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

const rowClass = "flex h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-3 text-left text-[13px] text-ink transition-colors hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";

/** One navigation surface: commands, projects, session history and settings. */
export function Sidebar({ collapsed = false, onCollapse }: { collapsed?: boolean; onCollapse?: () => void }): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const location = useLocation();
  const navigate = useNavigate();
  const routeRef = useRef(location.pathname + location.search);
  routeRef.current = location.pathname + location.search;
  const projects = useProjectsStore((state) => state.projects);
  const sessions = useSessionsStore((state) => state.sessions);
  const activeSessionId = useSessionsStore((state) => state.activeSessionId);
  const setActiveSession = useSessionsStore((state) => state.setActiveSession);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchLimit, setSearchLimit] = useState(60);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [deletingSession, setDeletingSession] = useState<UiSession>();
  const [deleting, setDeleting] = useState(false);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchResults = useRef<HTMLDivElement>(null);

  const newConversation = useCallback((projectId?: string) => {
    setActiveSession(undefined);
    navigate(`/sessions?new=1${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}`);
  }, [navigate, setActiveSession]);

  const selectSession = (id: string): void => {
    const session = sessions.find((item) => item.id === id);
    if (!session) return;
    setActiveSession(id);
    setSearchOpen(false);
    setQuery("");
    navigate(sessionLocation(session));
    requestAnimationFrame(() => document.getElementById("main-content")?.focus());
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        newConversation();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newConversation]);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = requestAnimationFrame(() => searchInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [searchOpen]);

  const closeSearch = (open: boolean): void => {
    setSearchOpen(open);
    if (!open) {
      setQuery("");
      setSearchLimit(60);
      requestAnimationFrame(() => {
        if (collapsed) document.getElementById("sidebar-expand")?.focus();
        else searchTrigger.current?.focus();
      });
    }
  };

  const deferredQuery = useDeferredValue(query);
  const results = useMemo(() => searchSidebarSessions(sessions, projects, deferredQuery), [deferredQuery, sessions, projects]);
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const projectResults = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    return projects.filter((project) => !needle || project.name.toLocaleLowerCase().includes(needle));
  }, [deferredQuery, projects]);
  const openProject = (id: string): void => {
    setSearchOpen(false);
    setQuery("");
    navigate(`/projects/${encodeURIComponent(id)}`);
    requestAnimationFrame(() => document.getElementById("main-content")?.focus());
  };

  const removeSession = async (): Promise<void> => {
    if (!deletingSession) return;
    const routeAtDelete = routeRef.current;
    setDeleting(true);
    try {
      await deleteWorkbenchSession(deletingSession.id);
      const current = useSessionsStore.getState();
      if (activeSessionId && !current.sessions.some((session) => session.id === activeSessionId)
        && routeRef.current === routeAtDelete) newConversation();
      setDeletingSession(undefined);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <nav id="workspace-sidebar" aria-label={t("nav.section")} hidden={collapsed}
        className={cn("sidebar-rail relative z-20 min-w-0 shrink-0 flex-col border-r border-line/70 bg-panel", collapsed ? "hidden" : "flex w-[232px] max-[1100px]:w-[208px] max-[760px]:w-[184px]")}>
        <div className="flex h-10 shrink-0 items-center justify-end px-3">
          {onCollapse && <button id="sidebar-collapse" type="button" onClick={onCollapse} aria-label={zh ? "收起侧栏" : "Collapse sidebar"} title={zh ? "收起侧栏" : "Collapse sidebar"} aria-expanded="true" aria-controls="workspace-sidebar"
            className="rounded-md p-1.5 text-ink-2 hover:bg-card-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><PanelLeftClose className="h-4 w-4" aria-hidden /></button>}
        </div>
        <div className="mx-3 space-y-1 border-b border-line/70 pb-4">
          <button className={cn(rowClass, new URLSearchParams(location.search).get("new") === "1" && "bg-card-hover")} onClick={() => newConversation()} data-tour="sessions-new" title={zh ? "新会话 · Ctrl/⌘ N" : "New chat · Ctrl/⌘ N"}>
            <Plus className="h-4 w-4 shrink-0" aria-hidden />{zh ? "新会话" : "New chat"}
          </button>
          <button ref={searchTrigger} className={rowClass} onClick={() => setSearchOpen(true)} title={zh ? "搜索 · Ctrl/⌘ K" : "Search · Ctrl/⌘ K"}>
            <Search className="h-4 w-4 shrink-0" aria-hidden />{zh ? "搜索" : "Search"}
          </button>
        </div>
        <div className="min-h-0 flex flex-1 flex-col px-1 pt-3" data-nav="sessions">
          <div className="flex items-center justify-between px-4 pb-2">
            <NavLink to="/projects" data-nav="projects" className="rounded py-1 text-xs text-ink-3 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50">{zh ? "项目" : "Projects"}</NavLink>
            <button onClick={() => setAddProjectOpen(true)} className="rounded-md p-1.5 text-ink-3 hover:bg-card-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50" title={t("projects.addTitle")} aria-label={t("projects.addTitle")}><Plus className="h-3.5 w-3.5" aria-hidden /></button>
          </div>
          <SessionListPanel embedded activeSessionId={new URLSearchParams(location.search).get("new") === "1" ? undefined : activeSessionId} onSelect={selectSession} onNew={newConversation} onDelete={setDeletingSession} />
          {projects.length === 0 && sessions.length === 0 && <button onClick={() => setAddProjectOpen(true)} className={cn(rowClass, "mx-2 mb-4 w-auto text-ink-3")}><Folder className="h-4 w-4 shrink-0" aria-hidden />{zh ? "添加项目" : "Add project"}</button>}
        </div>
        <div className="mx-3 mt-2 border-t border-line/60 py-3">
          <NavLink to="/settings" state={{ returnTo: location.pathname + location.search }} data-nav="settings" className={rowClass}><Settings className="h-4 w-4 shrink-0" aria-hidden />{t("nav.settings")}</NavLink>
        </div>
      </nav>
      <Dialog open={searchOpen} onOpenChange={closeSearch} title={zh ? "搜索" : "Search"} widthClass="max-w-[660px]" footer={<p className="mr-auto text-xs text-ink-3">{zh ? "↑ ↓ 选择　 Enter 打开　 Esc 关闭" : "↑ ↓ Select　 Enter Open　 Esc Close"}</p>}>
        <Input ref={searchInput} autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setSearchLimit(60); }} placeholder={zh ? "搜索标题或项目" : "Search titles or projects"} aria-label={zh ? "搜索标题或项目" : "Search titles or projects"} onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); searchResults.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            // A deferred search may still paint the previous query for one frame.
            const firstSession = searchSidebarSessions(sessions, projects, query)[0];
            const firstProject = projects.find((project) => project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
            if (firstSession) selectSession(firstSession.id);
            else if (firstProject) openProject(firstProject.id);
          }
        }} />
        <div ref={searchResults} className="mt-3 max-h-[45vh] space-y-1 overflow-y-auto" onKeyDown={(event) => {
          const buttons = Array.from(searchResults.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === "ArrowDown") { event.preventDefault(); buttons[Math.min(index + 1, buttons.length - 1)]?.focus(); }
          if (event.key === "ArrowUp") { event.preventDefault(); if (index <= 0) searchInput.current?.focus(); else buttons[index - 1]?.focus(); }
        }}>
          {results.length > 0 && <p className="px-3 pb-2 text-xs text-ink-3">{zh ? "会话" : "Chats"}</p>}
          {results.slice(0, searchLimit).map((session) => <button key={session.id} className={cn(rowClass, "h-auto min-h-14 items-start py-2.5")} onClick={() => selectSession(session.id)}><FileText className="mt-0.5 h-4 w-4 shrink-0 text-ink-2" aria-hidden /><span className="min-w-0"><span className="block truncate">{session.title}</span><span className="mt-1 block truncate text-xs text-ink-3">{projectNames.get(session.projectId) ?? (zh ? "未分组" : "Ungrouped")}</span></span></button>)}
          {results.length > searchLimit && <button className={cn(rowClass, "text-ink-3")} onClick={() => setSearchLimit((limit) => limit + 60)}>{zh ? "显示更多结果" : "Show more results"}</button>}
          {projectResults.length > 0 && <><p className="mt-3 border-t border-line px-3 pt-4 pb-2 text-xs text-ink-3">{zh ? "项目" : "Projects"}</p>{projectResults.slice(0, searchLimit).map((project) => <button key={project.id} onClick={() => openProject(project.id)} className={rowClass}><Folder className="h-4 w-4 shrink-0 text-ink-2" aria-hidden /><span className="truncate">{project.name}</span></button>)}{projectResults.length > searchLimit && <button className={cn(rowClass, "text-ink-3")} onClick={() => setSearchLimit((limit) => limit + 60)}>{zh ? "显示更多项目" : "Show more projects"}</button>}</>}
          {!results.length && !projectResults.length && <p className="py-8 text-center text-sm text-ink-3">{zh ? "没有找到结果" : "No results found"}</p>}

        </div>
      </Dialog>
      <AddProjectDialog open={addProjectOpen} onOpenChange={setAddProjectOpen} />
      <Dialog open={Boolean(deletingSession)} onOpenChange={(open) => { if (!open && !deleting) setDeletingSession(undefined); }} title={t("sessions.deleteTitle")} description={t("sessions.deleteDesc", { name: deletingSession?.title || t("sessions.header.untitled") })} footer={<><Button variant="outline" disabled={deleting} onClick={() => setDeletingSession(undefined)}>{t("common.cancel")}</Button><Button variant="danger" disabled={deleting} onClick={() => void removeSession()}>{deleting ? t("sessions.deleting") : t("sessions.delete")}</Button></>}>
        <p className="text-sm text-ink-2">{t("sessions.deleteHint")}</p>
      </Dialog>
    </>
  );
}
