import { useSettingsStore } from "../../stores/settings";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState, type ReactNode } from "react";
import { PanelLeftOpen } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { SessionsPage } from "../../features/sessions/SessionsPage";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";

export function PageTransition({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const systemReducedMotion = useReducedMotion();
  const appReducedMotion = useSettingsStore((state) => state.reduceMotion);
  const reduceMotion = systemReducedMotion || appReducedMotion;
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: reduceMotion ? 1 : 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.16 }}
      className={cn("min-h-full", className)}
    >
      {children}
    </motion.div>
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
  const toggleSidebar = (value: boolean): void => { setCollapsed(value); try { localStorage.setItem("nautilo.sidebar.collapsed", String(value)); } catch { /* Storage can be disabled. */ } };
  // The chat-first workbench uses the full width/height; other pages stay centered.
  const fullBleed = location.pathname.startsWith("/sessions") || location.pathname.startsWith("/work");
  const isSettings = location.pathname.startsWith("/settings");

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
          <div className="sidebar-slot" data-collapsed={collapsed}>
            <Sidebar collapsed={collapsed} onCollapse={() => {
              toggleSidebar(true);
              requestAnimationFrame(() => document.getElementById("sidebar-expand")?.focus());
            }} />
          </div>
        )}
        <main
          id="main-content"
          data-sidebar-collapsed={collapsed && !isSettings ? "true" : undefined}
          tabIndex={-1}
          className={cn("workspace-main relative min-w-0 flex-1 outline-none", fullBleed || isSettings ? "overflow-hidden" : "overflow-y-auto")}
        >
          {collapsed && !isSettings && <button id="sidebar-expand" type="button" onClick={() => { toggleSidebar(false); requestAnimationFrame(() => document.getElementById("sidebar-collapse")?.focus()); }} aria-label="展开侧栏" title="展开侧栏" className="absolute left-3 top-3 z-30 rounded-lg bg-canvas p-2 text-ink-2 hover:bg-panel focus-visible:ring-2 focus-visible:ring-accent"><PanelLeftOpen className="h-4 w-4" /></button>}
          {/* One mounted workspace for /sessions and the legacy /work URL. */}
          <div className={cn("relative h-full overflow-hidden", !fullBleed && "hidden")} aria-hidden={!fullBleed}>
            <SessionsPage active={fullBleed} />
          </div>
          {isSettings ? children : !fullBleed ? (
            <div className={cn("mx-auto max-w-6xl px-7 py-7", collapsed && "pt-14")}>
              {/* NOTE: do NOT pass initial={false} here. With it, framer-motion
                  mounts the incoming page at its animate values (opacity 1)
                  for the first frame and only then applies the initial state
                  and plays the entrance — the page visibly flashes fully
                  rendered before sliding/fading in. Default (initial=true)
                  renders the first frame at opacity 0 so the switch is a pure
                  entrance animation. */}
              <AnimatePresence mode="wait">
                <PageTransition key={location.pathname}>{children}</PageTransition>
              </AnimatePresence>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
