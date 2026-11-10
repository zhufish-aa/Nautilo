import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useUsageStore } from "../../stores/usage";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, Layers3, Loader2, Shrink, X } from "lucide-react";
import type { SlashCommandDefinition } from "@agenthub/domain";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useAgentsStore } from "../../stores/agents";
import { useSessionsStore } from "../../stores/sessions";
import { UI_EASE_OUT, useUiReducedMotion } from "../../lib/ui-motion";
import "./context-usage.css";

const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const CLOSE_DELAY_MS = 150;

function tokenLabel(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

/** Shared context-usage derivation (indicator ring + Composer compact banner). */
export function useContextUsage(sessionId?: string): { used?: number; limit?: number; percentage?: number } {
  const session = useSessionsStore((state) => state.sessions.find((item) => item.id === sessionId));
  const usage = useSessionsStore((state) => sessionId ? state.contextUsage[sessionId] : undefined);
  const instances = useAgentsStore((state) => state.instances);
  const catalogs = useAgentsStore((state) => state.modelCatalogs);
  if (!sessionId || !session) return {};
  const instanceId = session.target.type === "agent" ? session.target.instanceId : undefined;
  const instance = instances.find((item) => item.id === instanceId);
  const catalog = instance ? catalogs[instance.id] : undefined;
  const modelId = session.model || catalog?.defaultModel;
  const model = catalog?.models.find((item) => item.id === modelId);
  const used = usage?.contextUsed;
  const limit = usage?.contextWindow ?? model?.contextWindow;
  const percentage = used !== undefined && limit
    ? Math.min(100, Math.max(0, (used / limit) * 100))
    : undefined;
  return { used, limit, percentage };
}

export function ContextUsageIndicator({
  sessionId,
  compactCommand,
  onCompact,
  compactDisabled,
  compactLoading
}: {
  sessionId?: string;
  /** Native /compact command of the session's CLI; absent (e.g. codex) hides the button. */
  compactCommand?: SlashCommandDefinition;
  onCompact?: () => void;
  compactDisabled?: boolean;
  compactLoading?: boolean;
}): JSX.Element | null {
  const { t, locale } = useI18n();
  const { used, limit, percentage } = useContextUsage(sessionId);
  const sessionUsage = useUsageStore(state => sessionId ? state.summaries[sessionId] : undefined);
  const reducedMotion = useUiReducedMotion();
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();

  // Interactive popover: stays open while hovered, closes with a small delay
  // after leaving trigger or panel, and on Escape.
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const cancelClose = (): void => window.clearTimeout(closeTimerRef.current);
  const scheduleClose = (): void => {
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  useEffect(() => () => window.clearTimeout(closeTimerRef.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const surface = panel.current;
      if (!anchor || !surface) return;
      const width = surface.offsetWidth;
      const height = surface.offsetHeight;
      const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
      const above = anchor.top - height - 10;
      const top = above >= 8 ? above : Math.max(8, Math.min(anchor.bottom + 10, window.innerHeight - height - 8));
      setPosition(current => current?.left === left && current.top === top ? current : { left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, compactLoading, compactCommand, used, limit]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    };
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", dismiss);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("pointerdown", dismiss); };
  }, [open]);

  const sessionExists = useSessionsStore((state) => state.sessions.some((item) => item.id === sessionId));
  if (!sessionId || !sessionExists) return null;

  const zh = locale === "zh-CN";
  const usageText = used !== undefined && limit
    ? `${zh ? "上下文" : "Context"} ${tokenLabel(used)} / ${tokenLabel(limit)} tokens (${Math.round(percentage ?? 0)}%)`
    : used !== undefined
      ? `${zh ? "当前上下文" : "Current context"} ${tokenLabel(used)} tokens · ${zh ? "上限未知" : "limit unavailable"}`
      : limit
        ? `${zh ? "上下文上限" : "Context limit"} ${tokenLabel(limit)} tokens · ${zh ? "等待 Provider 返回使用量" : "waiting for provider usage"}`
        : (zh ? "上下文使用量暂不可用" : "Context usage unavailable");
  const tooltip = compactLoading ? t("sessions.composer.compacting") : usageText;
  const tone = percentage === undefined ? "text-ink-3" : percentage >= 90 ? "text-danger" : percentage >= 75 ? "text-warn" : "text-accent";

  return (
    <div
      className="composer-context-control relative inline-flex shrink-0"
      onMouseEnter={() => { cancelClose(); setOpen(true); }}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        ref={trigger}
        className={cn("relative grid h-8 w-8 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/45", tone)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={tooltip}
        onClick={() => { cancelClose(); setOpen(true); }}
        onKeyDown={event => { if (event.key === "ArrowDown" && open) { event.preventDefault(); panel.current?.querySelector<HTMLElement>("a, button:not(:disabled)")?.focus(); } }}
        onBlur={scheduleClose}
      >
        {compactLoading ? (
          <Loader2 className="h-4.5 w-4.5 animate-spin" aria-hidden />
        ) : (
          <svg viewBox="0 0 24 24" className="h-5 w-5 -rotate-90" aria-hidden>
            <circle cx="12" cy="12" r={RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
            {percentage !== undefined ? (
              <motion.circle
                cx="12"
                cy="12"
                r={RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={CIRCUMFERENCE}
                initial={false}
                animate={{ strokeDashoffset: CIRCUMFERENCE * (1 - percentage / 100) }}
                transition={{ duration: reducedMotion ? 0 : 0.2, ease: UI_EASE_OUT }}
              />
            ) : (
              <circle cx="12" cy="12" r="1.5" fill="currentColor" opacity="0.55" />
            )}
          </svg>
        )}
      </button>

      {createPortal(<AnimatePresence>
        {open && <motion.div
          ref={panel}
          id={panelId}
          role="dialog"
          aria-label={zh ? "上下文用量" : "Context usage"}
          className="context-usage-popover"
          style={position ?? { left: 0, top: 0, visibility: "hidden" }}
          initial={{ opacity: 0, transform: "translateY(5px) scale(0.98)" }}
          animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
          exit={{ opacity: 0, transform: "translateY(3px) scale(0.985)" }}
          transition={{ duration: reducedMotion ? 0 : 0.16, ease: UI_EASE_OUT }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onFocus={cancelClose}
          onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) scheduleClose(); }}
          onClick={(event) => event.stopPropagation()}
        >
          <header className="context-usage-heading">
            <span><Layers3 size={15} strokeWidth={1.7} aria-hidden />{zh ? "上下文" : "Context"}</span>
            <button type="button" aria-label={zh ? "关闭上下文用量" : "Close context usage"} onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={15}/></button>
          </header>
          <div className="context-usage-value"><strong>{used === undefined ? "—" : tokenLabel(used)}</strong><span>/ {limit ? tokenLabel(limit) : zh ? "上限未知" : "Unknown limit"}</span></div>
          {percentage !== undefined && <div className="context-usage-meter"><div className="context-usage-track" role="progressbar" aria-label={zh ? "上下文占用" : "Context used"} aria-valuenow={Math.round(percentage)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ transform: `scaleX(${percentage / 100})` }} data-level={percentage >= 90 ? "high" : undefined} />
          </div><span>{Math.round(percentage)}%</span></div>}
          <dl className="context-usage-stats">
            <div><dt>{zh ? "可用空间" : "Available context"}</dt><dd>{limit && used !== undefined ? tokenLabel(Math.max(0, limit - used)) : "—"}</dd></div>
            <div><dt>{zh ? "累计用量" : "Total usage"}</dt><dd>{sessionUsage?.totalTokens === undefined ? "—" : tokenLabel(sessionUsage.totalTokens)}</dd></div>
          </dl>
          <footer className="context-usage-actions">
          <Link to={`/settings?section=usage&session=${encodeURIComponent(sessionId)}`} onClick={() => setOpen(false)}>{zh ? "会话用量" : "Session usage"}<ArrowUpRight size={13} aria-hidden /></Link>
          {compactCommand && (
            <button
              type="button"
              disabled={compactDisabled || compactLoading || !onCompact}
              onClick={(event) => {
                event.stopPropagation();
                onCompact?.();
              }}
              className="context-usage-compact"
            >
              {compactLoading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Shrink className="h-3 w-3" aria-hidden />}
              {t(compactLoading ? "sessions.composer.compacting" : "sessions.composer.compact")}
            </button>
          )}
          </footer>
        </motion.div>}
      </AnimatePresence>, document.body)}
    </div>
  );
}
