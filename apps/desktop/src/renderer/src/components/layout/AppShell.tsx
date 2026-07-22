import { AnimatePresence, motion } from "framer-motion";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";

function AuroraBackground(): JSX.Element {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `linear-gradient(var(--grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--grid-line) 1px, transparent 1px)`,
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse 90% 70% at 50% 0%, black 30%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(ellipse 90% 70% at 50% 0%, black 30%, transparent 75%)"
        }}
      />
      <div
        className="absolute -top-40 left-[8%] h-[420px] w-[560px] rounded-full blur-[110px] motion-safe:animate-drift-slow"
        style={{ background: "var(--aurora-1)" }}
      />
      <div
        className="absolute top-[30%] right-[-6%] h-[380px] w-[480px] rounded-full blur-[120px] motion-safe:animate-drift-slower"
        style={{ background: "var(--aurora-2)" }}
      />
    </div>
  );
}

export function PageTransition({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
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
  // The chat-first workbench uses the full width/height; other pages stay centered.
  const fullBleed = location.pathname.startsWith("/sessions");

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas text-ink">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-lg bg-accent px-3 py-2 text-sm text-on-accent focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        {t("app.skipToContent")}
      </a>
      <AuroraBackground />
      <TitleBar />
      <div className="relative z-10 flex min-h-0 flex-1">
        <Sidebar />
        <main
          id="main-content"
          tabIndex={-1}
          className={cn("min-w-0 flex-1 outline-none", fullBleed ? "overflow-hidden" : "overflow-y-auto")}
        >
          {fullBleed ? (
            <div className="h-full overflow-hidden">
              <AnimatePresence mode="wait" initial={false}>
                <PageTransition key={location.pathname} className="h-full">
                  {children}
                </PageTransition>
              </AnimatePresence>
            </div>
          ) : (
            <div className="mx-auto max-w-6xl px-7 py-7">
              <AnimatePresence mode="wait" initial={false}>
                <PageTransition key={location.pathname}>{children}</PageTransition>
              </AnimatePresence>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
