import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, Loader2, RotateCw, TerminalSquare } from "lucide-react";
import type { ChipTone } from "../../components/ui/Badge";
import { IdentityAvatar, ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { formatDurationMs } from "../../lib/subagent-result";
import { useUiReducedMotion } from "../../lib/ui-motion";
import "./DelegationCard.css";

export interface SubagentItemModel {
  id: string;
  title: string;
  status: string;
  tone: ChipTone;
  running?: boolean;
  cancelled?: boolean;
  providerId?: string;
  avatarLabel: string;
  /** Compact metadata parts shown on the subtitle line, e.g. ["Codex", "GPT-6.2-Sol", "High"]. */
  metaParts?: string[];
  /** Completed or known elapsed duration in ms. */
  durationMs?: number;
  /** Epoch timestamp (ms) when the subagent started, used for live ticking while running. */
  startedAtMs?: number;
  /** 2–3 line preview snippet (final result > live activity > task prompt). */
  snippet?: string;
  snippetKind?: "result" | "activity" | "task";
  /** Click handler for opening the child session or subagent detail drawer. */
  onOpen?: () => void;
  actionLabel?: string;
  onRetry?: () => Promise<void>;
  /** Optional raw call details disclosure (shown only when row cannot navigate to a child session/drawer). */
  input?: string;
  output?: string;
  toolName?: string;
  task?: string;
  native?: boolean;
  time?: string;
}

function formatCompactDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function useLiveNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function resolveItemDuration(item: SubagentItemModel, now: number): number | undefined {
  if (item.running && item.startedAtMs !== undefined && Number.isFinite(item.startedAtMs)) {
    return Math.max(0, now - item.startedAtMs);
  }
  if (item.durationMs !== undefined && Number.isFinite(item.durationMs) && item.durationMs >= 0) {
    return item.durationMs;
  }
  return undefined;
}

function SubagentAvatar({ providerId, label, size = "sm" }: { providerId?: string; label: string; size?: "sm" | "md" }): JSX.Element {
  if (providerId) return <ProviderAvatar providerId={providerId} size={size} />;
  return <IdentityAvatar label={label} size={size} />;
}

function SubagentRow({ item, index, zh, now }: {
  item: SubagentItemModel;
  index: number;
  zh: boolean;
  now: number;
}): JSX.Element {
  const titleId = useId();
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsMounted, setDetailsMounted] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string>();

  useEffect(() => {
    if (detailsOpen) { setDetailsMounted(true); return; }
    if (!detailsMounted) return;
    const timer = window.setTimeout(() => setDetailsMounted(false), 260);
    return () => window.clearTimeout(timer);
  }, [detailsOpen, detailsMounted]);

  const clickable = Boolean(item.onOpen);
  // Keep rows visually clean like the reference: only expose inline raw-details toggle
  // when there is no child session / subagent detail drawer to open directly.
  const hasDetails = !clickable && Boolean(item.input || item.output || (item.native && item.task));
  const durationMs = resolveItemDuration(item, now);
  const durationLabel = formatCompactDuration(durationMs);
  const metaText = item.metaParts?.filter(Boolean).join(" · ");

  const handleRowClick = (): void => {
    item.onOpen?.();
  };

  const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!clickable) return;
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      item.onOpen?.();
    }
  };

  const handleToggleDetails = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    setDetailsOpen((open) => !open);
  };

  const handleRetry = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    if (!item.onRetry) return;
    setRetrying(true);
    setRetryError(undefined);
    void item.onRetry()
      .catch((error) => setRetryError(String(error)))
      .finally(() => setRetrying(false));
  };

  return (
    <div
      className="subagent-row"
      data-clickable={clickable || undefined}
      data-running={item.running || undefined}
      data-tone={item.tone}
      style={{ "--row-index": Math.min(index, 5) } as CSSProperties}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-labelledby={titleId}
      onClick={clickable ? handleRowClick : undefined}
      onKeyDown={clickable ? handleRowKeyDown : undefined}
    >
      <span
        className="subagent-status-dot"
        data-tone={item.tone}
        data-running={item.running || undefined}
        aria-hidden
      />

      <div className="subagent-row-main">
        <div className="subagent-row-top">
          <div className="subagent-row-heading">
            <h4 id={titleId} className="subagent-row-title" title={item.title}>
              {item.title}
            </h4>
            <span className="subagent-row-sep" aria-hidden>·</span>
            <span
              className="subagent-row-status"
              data-tone={item.tone}
              data-running={item.running || undefined}
              role="status"
            >
              {item.status}
            </span>
          </div>

          <div className="subagent-row-trailing">
            {durationLabel && (
              <span className="subagent-row-duration" title={item.time}>
                {durationLabel}
              </span>
            )}
            {clickable && (
              <ChevronRight
                size={16}
                strokeWidth={1.75}
                className="subagent-row-chevron"
                aria-label={item.actionLabel ?? (zh ? "查看子会话" : "Open session")}
              />
            )}
          </div>
        </div>

        {(item.providerId || metaText) && (
          <div className="subagent-row-meta">
            <span className="subagent-row-avatar" aria-hidden>
              <SubagentAvatar providerId={item.providerId} label={item.avatarLabel} size="sm" />
            </span>
            {metaText && <span className="subagent-row-meta-text" title={metaText}>{metaText}</span>}
          </div>
        )}

        {item.snippet && (
          <p
            className="subagent-row-snippet"
            data-kind={item.snippetKind ?? "task"}
            title={item.snippet}
          >
            {item.snippet}
          </p>
        )}

        {retryError && (
          <p className="subagent-row-error" role="alert">
            {retryError}
          </p>
        )}

        {(hasDetails || item.onRetry) && (
          <div className="subagent-row-actions">
            {hasDetails && (
              <button
                type="button"
                className="subagent-row-action"
                aria-expanded={detailsOpen}
                aria-controls={detailsId}
                onClick={handleToggleDetails}
              >
                <TerminalSquare size={12} aria-hidden />
                <span>{zh ? "调用详情" : "Call details"}</span>
                <ChevronDown size={12} className="subagent-row-action-chevron" aria-hidden />
              </button>
            )}
            {item.onRetry && (
              <button
                type="button"
                className="subagent-row-action subagent-row-action-retry"
                disabled={retrying}
                onClick={handleRetry}
              >
                {retrying
                  ? <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden />
                  : <RotateCw size={12} aria-hidden />}
                <span>{zh ? "重试此任务" : "Retry task"}</span>
              </button>
            )}
          </div>
        )}

        {hasDetails && (
          <div
            id={detailsId}
            className="subagent-row-details-fold"
            data-open={detailsOpen || undefined}
            aria-hidden={!detailsOpen || undefined}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="subagent-row-details-clip">
              {detailsMounted && (
                <div className="subagent-row-details">
                  {item.toolName && <div className="subagent-row-tool">{item.toolName}</div>}
                  {item.native && item.task && item.task !== item.input && (
                    <pre aria-label={zh ? "任务说明" : "Task instructions"}>{item.task}</pre>
                  )}
                  {item.input && <pre aria-label={zh ? "调用参数" : "Arguments"}>{item.input}</pre>}
                  {item.output && <pre aria-label={zh ? "调用结果" : "Result"}>{item.output}</pre>}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function SubagentGroup({ items, zh, defaultOpen = true }: {
  items: readonly SubagentItemModel[];
  zh: boolean;
  defaultOpen?: boolean;
}): JSX.Element | null {
  const panelId = useId();
  const clipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(defaultOpen);
  const reducedMotion = useUiReducedMotion();

  useLayoutEffect(() => {
    if (clipRef.current) clipRef.current.inert = !open;
  }, [open]);

  const hasRunning = items.some((item) => item.running);
  const now = useLiveNow(hasRunning);

  const summary = useMemo(() => {
    let running = 0;
    let done = 0;
    let failed = 0;
    let waiting = 0;
    let maxDuration: number | undefined;
    for (const item of items) {
      if (item.running) running++;
      else if (item.tone === "ok") done++;
      else if (item.tone === "danger") failed++;
      else if (item.tone === "warn") waiting++;

      const ms = resolveItemDuration(item, now);
      if (ms !== undefined) {
        maxDuration = maxDuration === undefined ? ms : Math.max(maxDuration, ms);
      }
    }
    return { running, done, failed, waiting, maxDuration };
  }, [items, now]);

  if (!items.length) return null;

  const count = items.length;
  const heading = zh
    ? `${count} 个子 Agent`
    : `${count} ${count === 1 ? "subagent" : "subagents"}`;

  const tallyParts: Array<{ key: string; text: string; tone?: "running" | "failed" | "warn" }> = [];
  if (summary.running > 0) {
    tallyParts.push({
      key: "running",
      text: zh ? `${summary.running} 个运行中` : `${summary.running} running`,
      tone: "running"
    });
  }
  if (summary.done > 0) {
    tallyParts.push({
      key: "done",
      text: zh ? `${summary.done} 个已完成` : `${summary.done} done`
    });
  }
  if (summary.failed > 0) {
    tallyParts.push({
      key: "failed",
      text: zh ? `${summary.failed} 个失败` : `${summary.failed} failed`,
      tone: "failed"
    });
  }
  if (summary.waiting > 0) {
    tallyParts.push({
      key: "waiting",
      text: zh ? `${summary.waiting} 个等待中` : `${summary.waiting} waiting`,
      tone: "warn"
    });
  }
  if (!tallyParts.length) {
    tallyParts.push({
      key: "other",
      text: items[0]!.status
    });
  }

  const stackItems = items.slice(0, 4);
  const overflowCount = Math.max(0, items.length - stackItems.length);
  const totalDuration = summary.maxDuration !== undefined
    ? formatCompactDuration(summary.maxDuration) ?? formatDurationMs(summary.maxDuration)
    : undefined;

  const handlePointerMove = (event: MouseEvent<HTMLDivElement>): void => {
    if (reducedMotion) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty("--my", `${event.clientY - rect.top}px`);
  };

  return (
    <section
      className="subagent-group"
      data-open={open || undefined}
      data-running={hasRunning || undefined}
      data-reduced-motion={reducedMotion || undefined}
      aria-label={heading}
    >
      <button
        type="button"
        className="subagent-group-header"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="subagent-avatar-stack" data-count={stackItems.length} aria-hidden>
          {stackItems.map((item, idx) => (
            <span
              key={item.id}
              className="subagent-stack-badge"
              data-running={item.running || undefined}
              style={{ zIndex: idx + 1 }}
            >
              <SubagentAvatar providerId={item.providerId} label={item.avatarLabel} size="sm" />
            </span>
          ))}
          {overflowCount > 0 && (
            <span className="subagent-stack-overflow" style={{ zIndex: stackItems.length + 1 }}>+{overflowCount}</span>
          )}
        </span>

        <span className="subagent-group-meta">
          <span className="subagent-group-title">{heading}</span>
          <span className="subagent-group-subtitle">
            {tallyParts.map((part, idx) => (
              <span key={part.key} className="subagent-tally-part" data-tone={part.tone}>
                {idx > 0 && <span className="subagent-tally-sep" aria-hidden>·</span>}
                {part.text}
              </span>
            ))}
          </span>
        </span>

        <span className="subagent-group-trailing">
          {totalDuration && <span className="subagent-group-duration">{totalDuration}</span>}
          <ChevronDown size={16} strokeWidth={1.8} className="subagent-group-chevron" aria-hidden />
        </span>
      </button>

      <div
        id={panelId}
        className="subagent-group-fold"
        data-open={open || undefined}
        aria-hidden={!open || undefined}
      >
        <div ref={clipRef} className="subagent-group-clip">
          <div
            className="subagent-group-panel"
            data-running={hasRunning || undefined}
            onMouseMove={handlePointerMove}
          >
            {items.map((item, index) => (
              <SubagentRow key={item.id} item={item} index={index} zh={zh} now={now} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Single-item wrapper preserved for standalone call sites. */
export function DelegationCard({
  name,
  task,
  status,
  tone,
  running,
  cancelled,
  meta,
  actionLabel,
  onOpen,
  input,
  output,
  toolName,
  native,
  time,
  zh,
  activity,
  result,
  onRetry,
  providerId,
  durationMs,
  startedAtMs
}: {
  name: string;
  task?: string;
  status: string;
  tone: ChipTone;
  running?: boolean;
  cancelled?: boolean;
  meta?: string[];
  actionLabel?: string;
  onOpen?: () => void;
  input?: string;
  output?: string;
  toolName?: string;
  native?: boolean;
  time?: string;
  zh: boolean;
  activity?: string;
  result?: string;
  onRetry?: () => Promise<void>;
  providerId?: string;
  durationMs?: number;
  startedAtMs?: number;
}): JSX.Element {
  const snippet = result ?? activity ?? task;
  const snippetKind = result ? "result" : activity ? "activity" : "task";
  const item: SubagentItemModel = {
    id: `${name}-${time ?? "single"}`,
    title: name,
    status,
    tone,
    running,
    cancelled,
    providerId,
    avatarLabel: name,
    metaParts: meta?.length ? meta : [native ? (zh ? "原生子 Agent" : "Native subagent") : (zh ? "团队委派" : "Team task")],
    durationMs,
    startedAtMs,
    snippet,
    snippetKind,
    onOpen,
    actionLabel,
    onRetry,
    input,
    output,
    toolName,
    task,
    native,
    time
  };
  return <SubagentGroup items={[item]} zh={zh} />;
}
