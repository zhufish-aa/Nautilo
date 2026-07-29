import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, Shrink } from "lucide-react";
import type { SlashCommandDefinition } from "@agenthub/domain";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useAgentsStore } from "../../stores/agents";
import { useSessionsStore } from "../../stores/sessions";

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
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
    <span
      className="relative inline-flex shrink-0"
      onMouseEnter={() => { cancelClose(); setOpen(true); }}
      onMouseLeave={scheduleClose}
      onFocus={() => { cancelClose(); setOpen(true); }}
      onBlur={scheduleClose}
    >
      <span
        className={cn("relative grid h-8 w-8 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/45", tone)}
        role="img"
        tabIndex={0}
        aria-label={tooltip}
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
                transition={{ type: "spring", stiffness: 260, damping: 30 }}
              />
            ) : (
              <circle cx="12" cy="12" r="1.5" fill="currentColor" opacity="0.55" />
            )}
          </svg>
        )}
      </span>

      {open && (
        <span
          role="tooltip"
          className="animate-pop-in absolute bottom-full right-0 z-50 mb-2 w-60 rounded-lg border border-line bg-card-hover px-3 py-2 text-xs text-ink shadow-pop"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onClick={(event) => event.stopPropagation()}
        >
          <span className="block leading-relaxed">{tooltip}</span>
          {compactCommand && (
            <button
              type="button"
              disabled={compactDisabled}
              onClick={(event) => {
                event.stopPropagation();
                onCompact?.();
              }}
              className="mt-2 flex h-7 items-center gap-1.5 rounded-full border border-line-strong bg-card px-2.5 text-[11px] font-medium text-ink-2 transition-colors hover:bg-card hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {compactLoading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Shrink className="h-3 w-3" aria-hidden />}
              {t("sessions.composer.compact")}
            </button>
          )}
        </span>
      )}
    </span>
  );
}
