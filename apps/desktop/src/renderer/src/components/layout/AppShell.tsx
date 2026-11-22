import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import {ResizeHandle,useRememberedWidth} from "../ui/ResizeHandle";
import { useLocation } from "react-router-dom";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { SessionsPage } from "../../features/sessions/SessionsPage";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";
import { useSurfaceEntrance } from "../../lib/ui-motion";

export function PageTransition({
  children,
  className,
  transitionKey
}: {
  children: ReactNode;
  className?: string;
  transitionKey?: string;
}): JSX.Element {
  const ref = useSurfaceEntrance<HTMLDivElement>(transitionKey);
  return (
    <div ref={ref}
      className={cn("min-h-full", className)}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2.5">{actions}</div>}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useI18n();
  const location = useLocation();
  const shell = useRef<HTMLDivElement>(null);
  const [gitExpanded, setGitExpanded] = useState(false);
  useEffect(() => {
    const panel = gitExpanded && shell.current?.querySelector(".scm-drawer:not([hidden])");
    if (!panel || !shell.current) return;
    const observer = new MutationObserver(() => { if (!panel.isConnected) setGitExpanded(false); });
    observer.observe(shell.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [gitExpanded]);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem("nautilo.sidebar.collapsed") === "true"; } catch { return false; } });
  const [assistantExpanded, setAssistantExpanded] = useState(false);
  const sidebarWidth=useRememberedWidth("nautilo.sidebar.width",window.innerWidth<=780?180:window.innerWidth<=1100?240:280,180,480);
  const toggleSidebar = (value: boolean): void => { setCollapsed(value); try { localStorage.setItem("nautilo.sidebar.collapsed", String(value)); } catch { /* Storage can be disabled. */ } };
  // The chat-first workbench uses the full width/height; other pages stay centered.
  const fullBleed = location.pathname === "/work" || location.pathname === "/sessions" || location.pathname.startsWith("/sessions/");
  const isAssistant = location.pathname === "/assistant";
  const iconRail = isAssistant ? !assistantExpanded : collapsed;
  useEffect(() => {
    if (!isAssistant) setAssistantExpanded(false);
  }, [isAssistant]);
  const isSettings = location.pathname.startsWith("/settings");
  const isRuns = location.pathname === "/runs";
  const isWorkflows = location.pathname === "/workflows";

  return (
    <div ref={shell} className="app-shell flex h-screen flex-col overflow-hidden text-ink" data-git-sidebar-expanded={gitExpanded || undefined}>
      <a
        href="#main-content"
        className="sr-only z-50 rounded-lg bg-accent px-3 py-2 text-sm text-on-accent focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        {t("app.skipToContent")}
      </a>
      <TitleBar />
      <div className="relative z-10 flex min-h-0 flex-1">
        {!isSettings && (
          <div className="sidebar-slot" data-icon-rail={iconRail || undefined} style={{"--sidebar-width":`${sidebarWidth.width}px`} as CSSProperties}>
            <Sidebar onToggle={(expand) => {
              if (isAssistant) {
                setAssistantExpanded(expand);
              } else if (window.innerWidth < 1560 && shell.current?.querySelector(".scm-drawer:not([hidden])")) {
                setGitExpanded(expand);
              } else {
                toggleSidebar(!expand);
              }
              requestAnimationFrame(() => document.getElementById(expand ? "sidebar-collapse" : "sidebar-expand")?.focus());
            }} />
            <ResizeHandle label="调整侧栏宽度" value={sidebarWidth.width} min={180} max={480} onChange={sidebarWidth.resize} onCommit={sidebarWidth.save} reset={280}/>
          </div>
        )}
        <div className={cn("flex min-h-0 min-w-0 flex-1 overflow-hidden", !isSettings && "workspace-stage")}>
          <main
            id="main-content"
            tabIndex={-1}
            className={cn("workspace-main relative min-w-0 flex-1 outline-none", fullBleed || isSettings || isAssistant ? "overflow-hidden" : "overflow-y-auto")}
          >
            {/* One mounted workspace for /sessions and the legacy /work URL. */}
            <div className={cn("relative h-full overflow-hidden", !fullBleed && "hidden")} aria-hidden={!fullBleed}>
              <SessionsPage active={fullBleed} />
            </div>
            {isSettings || isAssistant ? children : !fullBleed ? (
              <div className={isRuns ? "runs-route-surface min-h-full w-full" : isWorkflows ? "workflow-route h-full w-full" : cn("mx-auto px-7 py-7", /^\/teams(?:\/|$)/.test(location.pathname) ? "max-w-[1216px]" : "max-w-6xl")}>
                <PageTransition className={isWorkflows ? "h-full" : undefined} transitionKey={location.pathname}>{children}</PageTransition>
              </div>
            ) : null}
          </main>
        </div>
      </div>
    </div>
  );
}
