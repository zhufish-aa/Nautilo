import { useState, type ReactNode, type CSSProperties } from "react";
import {ResizeHandle,useRememberedWidth} from "../ui/ResizeHandle";
import { PanelLeftOpen } from "lucide-react";
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
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem("nautilo.sidebar.collapsed") === "true"; } catch { return false; } });
  const sidebarWidth=useRememberedWidth("nautilo.sidebar.width",window.innerWidth<=780?180:window.innerWidth<=1100?240:280,180,480);
  const toggleSidebar = (value: boolean): void => { setCollapsed(value); try { localStorage.setItem("nautilo.sidebar.collapsed", String(value)); } catch { /* Storage can be disabled. */ } };
  // The chat-first workbench uses the full width/height; other pages stay centered.
  const fullBleed = location.pathname.startsWith("/sessions") || location.pathname.startsWith("/work");
  const isAssistant = location.pathname === "/assistant";
  const isSettings = location.pathname.startsWith("/settings");
  const isRuns = location.pathname === "/runs";

  return (
    <div className="app-shell flex h-screen flex-col overflow-hidden bg-canvas text-ink">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-lg bg-accent px-3 py-2 text-sm text-on-accent focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        {t("app.skipToContent")}
      </a>
      <TitleBar />
      <div className="relative z-10 flex min-h-0 flex-1">
        {!isSettings && (
          <div className="sidebar-slot" data-collapsed={collapsed} style={{"--sidebar-width":`${sidebarWidth.width}px`,position:"relative",overflow:collapsed?"hidden":"visible",transition:"none"} as CSSProperties}>
            <Sidebar collapsed={collapsed} onCollapse={() => {
              toggleSidebar(true);
              requestAnimationFrame(() => document.getElementById("sidebar-expand")?.focus());
            }} />
            {!collapsed&&<ResizeHandle label="调整侧栏宽度" value={sidebarWidth.width} min={180} max={480} onChange={sidebarWidth.resize} onCommit={sidebarWidth.save} reset={280}/>}
          </div>
        )}
        <main
          id="main-content"
          data-sidebar-collapsed={collapsed && !isSettings ? "true" : undefined}
          tabIndex={-1}
          className={cn("workspace-main relative min-w-0 flex-1 outline-none", fullBleed || isSettings || isAssistant ? "overflow-hidden" : "overflow-y-auto")}
        >
          {collapsed && !isSettings && <button id="sidebar-expand" type="button" onClick={() => { toggleSidebar(false); requestAnimationFrame(() => document.getElementById("sidebar-collapse")?.focus()); }} aria-label="展开侧栏" title="展开侧栏" className="absolute left-3 top-3 z-30 rounded-lg bg-canvas p-2 text-ink-2 hover:bg-panel focus-visible:ring-2 focus-visible:ring-accent"><PanelLeftOpen className="h-4 w-4" /></button>}
          {/* One mounted workspace for /sessions and the legacy /work URL. */}
          <div className={cn("relative h-full overflow-hidden", !fullBleed && "hidden")} aria-hidden={!fullBleed}>
            <SessionsPage active={fullBleed} />
          </div>
          {isSettings || isAssistant ? children : !fullBleed ? (
            <div className={cn(isRuns ? "runs-route-surface min-h-full w-full" : "mx-auto max-w-6xl px-7 py-7", collapsed && "pt-14")}>
              <PageTransition transitionKey={location.pathname}>{children}</PageTransition>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
