import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRightLeft,
  Bot,
  Check,
  ChevronDown,
  ClipboardList,
  Copy,
  FileCode2,
  FileText,
  FlaskConical,
  GitBranch,
  ImageIcon,
  Loader2,
  Pencil,
  X
} from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { cn, formatDateTime } from "../../lib/utils";
import type { ApprovalScope, TimelineEvent } from "../../lib/types";
import { StatusChip, Tag } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { resolveWorkbenchApproval } from "../../lib/orchestration-runtime";
import { toolActivityLabel, toolInputFileDiff } from "../../lib/tool-display";
import { MarkdownContent } from "./MarkdownContent";
import { useStreamingText } from "../../lib/streaming-text";
import { reconcileTimelineKeys, type TimelineKeySequence } from "../../lib/timeline-row-keys";
import { ToolFileDiffView } from "./ToolFileDiffView";
import { TimelineImage } from "./TimelineImage";
import { artifactUrlForPath, openFileWithToast, popupFileMenu, popupTextMenu } from "./media-actions";
import { openFilePreview } from "../../stores/file-preview";
import { resolveFileOpenTarget } from "../../lib/file-references";
import { fileChangeCounts } from "../../lib/changed-files";
import { diffLines } from "../../lib/line-diff";
import { useVirtualizer } from "@tanstack/react-virtual";

const FOLLOW_TAIL_THRESHOLD = 120;

/**
 * Owns the vertical viewport for a timeline. TimelineEventView below is a
 * card renderer; this component is the layer that can actually observe and
 * control the scrolling element.
 */
export interface TimelineRow {
  key: string;
  render: () => ReactNode;
}

/**
 * Owns the vertical viewport for a timeline. Virtualizes the row list so only
 * the visible rows (plus a small overscan) are mounted: a long session's DOM
 * stays bounded regardless of how many turns/answers it holds. Follow-tail
 * behavior is preserved: scrolling up pauses follow mode, scrolling back into
 * the tail re-engages it, and any content/row change while following pins the
 * view to the newest tail.
 */
export function TimelineViewport({
  rows,
  sessionKey,
  contentKey,
  forceFollowKey,
  active = true,
  className
}: {
  rows: TimelineRow[];
  sessionKey: string;
  contentKey?: unknown;
  forceFollowKey?: string;
  active?: boolean;
  className?: string;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const previousForceFollowKeyRef = useRef(forceFollowKey);
  const previousContentKeyRef = useRef<unknown>(contentKey);
  const previousRowCountRef = useRef(rows.length);

  const keySequenceRef = useRef<TimelineKeySequence>();
  const keySequence = reconcileTimelineKeys(keySequenceRef.current, rows, sessionKey);
  keySequenceRef.current = keySequence;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // A folded turn block (header + fold row + answer) is typically under
    // 100px; estimate low so the scrollbar starts near the measured total
    // instead of visibly shrinking as rows get measured.
    estimateSize: () => 96,
    // Keep overscan tight: each row renders markdown on mount, and extra
    // off-screen rows would parse long answers before they are visible.
    overscan: 2,
    getItemKey: keySequence.getItemKey
  });

  const scrollToTail = useCallback(() => {
    if (!active || !followTailRef.current) return;
    const element = scrollRef.current;
    if (!element) return;
    // Direct DOM pin to the tail, exactly like the pre-virtualization version:
    // scrollTop = scrollHeight reflects the real, freshly laid-out content
    // height (no virtualizer state lag). The virtualizer observes scroll via
    // the scroll event and re-windows accordingly.
    element.scrollTop = element.scrollHeight;
    lastScrollTopRef.current = element.scrollTop;
  }, [active]);

  // A newly opened session (or a page becoming visible again) starts at the
  // tail. This runs after the layout has a real height, unlike a one-time
  // scroll in the parent workbench.
  useLayoutEffect(() => {
    if (!active) return;
    followTailRef.current = true;
    scrollToTail();
  }, [active, scrollToTail, sessionKey]);

  // Event arrays are replaced for both appended events and streaming patches.
  // The virtualizer re-measures rows, so a growing live turn changes the total
  // height; while following, pin the view to the new tail.
  useLayoutEffect(() => {
    if (contentKey === previousContentKeyRef.current) return;
    previousContentKeyRef.current = contentKey;
    scrollToTail();
  }, [contentKey, scrollToTail]);

  // Rows are added when new turns start and removed on session switch. Keep
  // the tail pinned while following even when the row count itself changes.
  useLayoutEffect(() => {
    if (rows.length === previousRowCountRef.current) return;
    previousRowCountRef.current = rows.length;
    scrollToTail();
  }, [rows.length, scrollToTail]);

  useLayoutEffect(() => {
    if (forceFollowKey === previousForceFollowKeyRef.current) return;
    previousForceFollowKeyRef.current = forceFollowKey;
    if (forceFollowKey === undefined) return;
    followTailRef.current = true;
    scrollToTail();
  }, [forceFollowKey, scrollToTail]);

  // Height-only changes (markdown layout, images, framer-motion settling) and
  // the virtualizer's own row measurement update the total height. Follow the
  // tail on those changes WITHOUT a ResizeObserver: observing the sized
  // container and scrolling from its callback re-measured rows every frame and
  // produced "ResizeObserver loop completed with undelivered notifications".
  const totalSize = virtualizer.getTotalSize();
  const previousTotalSizeRef = useRef(totalSize);
  useLayoutEffect(() => {
    if (totalSize === previousTotalSizeRef.current) return;
    previousTotalSizeRef.current = totalSize;
    scrollToTail();
  }, [totalSize, scrollToTail]);

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
        if (element.scrollTop < lastScrollTopRef.current - 1) {
          // Any upward scroll (wheel, thumb drag, keys) is explicit user
          // intent ? even inside the re-engage threshold.
          followTailRef.current = false;
        } else if (gap < FOLLOW_TAIL_THRESHOLD && element.scrollTop > lastScrollTopRef.current) {
          // Only scrolling DOWN into the tail re-engages follow mode.
          followTailRef.current = true;
        }
        lastScrollTopRef.current = element.scrollTop;
      }}
      onWheel={(event) => {
        // Wheel input is the other explicit way to pause follow mode.
        if (event.deltaY < 0) followTailRef.current = false;
      }}
      style={{ overflowAnchor: "none", willChange: "scroll-position" }}
      className={cn("relative h-full overflow-y-auto", className)}
      aria-live="polite"
    >
      <div style={{ height: totalSize, position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`
            }}
          >
            {rows[virtualRow.index]?.render()}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Unified click path for files referenced in the timeline. Work mode passes
 * onOpenLocalFile: previewable project files (PDF/Office/text/image…) open
 * in the right-hand preview pane, legacy .doc/.ppt stay on the system app.
 * Without the handler the exact Code-mode fallback (external app or preview
 * drawer, depending on the call site) is preserved.
 */
function openTimelineFile(
  path: string,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
  onOpenLocalFile: ((path: string) => void) | undefined,
  fallback: "external" | "drawer"
): void {
  if (onOpenLocalFile) {
    if (resolveFileOpenTarget(path, true) === "local-preview") {
      onOpenLocalFile(path);
      return;
    }
    void openFileWithToast(path, t);
    return;
  }
  if (fallback === "external") void openFileWithToast(path, t);
  else openFilePreview({ path });
}

function CardShell({
  icon: Icon,
  tone = "accent",
  title,
  time,
  children,
  className
}: {
  icon: typeof GitBranch;
  tone?: "accent" | "ok" | "warn" | "danger" | "info" | "muted";
  title?: React.ReactNode;
  time?: string;
  children?: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <article className={cn("min-w-0 py-1", className)} data-tone={tone}>
      {(title || time) && <div className="mb-2 flex min-w-0 items-center gap-2 text-sm text-ink-3" title={time}><Icon className="h-4 w-4 shrink-0" aria-hidden /><div className="min-w-0 flex-1">{title}</div></div>}
      {children}
    </article>
  );
}

function MessageCard({ event, locale, onEditMessage, onOpenLocalFile }: {
  event: TimelineEvent & { data: Extract<TimelineEvent["data"], { kind: "message" }> };
  locale: "zh-CN" | "en-US";
  onEditMessage?: (messageId: string, text: string) => void;
  onOpenLocalFile?: (path: string) => void;
}): JSX.Element {
  const { sender, authorName, text, streaming, messageId, attachments, editedAt } = event.data;
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const isUser = sender === "user";
  const isSystem = sender === "system";
  const visibleText = useStreamingText(text, Boolean(streaming), `${event.sessionId}:${event.id}`);
  // Historical messages render statically on remounts (mode switches reopen the
  // whole timeline); only fresh live-conversation rows pay for the spring-in.
  const animateIn = Date.now() - new Date(event.timestamp).getTime() < 10_000;
  if (isSystem) {
    return (
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="log-line py-1 text-center text-ink-3"
      >
        — {text} · {formatDateTime(event.timestamp, locale)} —
      </motion.p>
    );
  }
  return (
      <motion.div
      initial={animateIn ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 500, damping: 45 }}
      className="group relative flex w-full"
    >
      <div className={cn("min-w-0 flex-1", isUser && "flex flex-col items-end")}>
        <span className="sr-only">{isUser ? (locale === "zh-CN" ? "你" : "You") : authorName ?? "Nautilo"}</span>
        <div
          className={cn(
            "text-[15px] leading-7 text-ink",
            isUser && "chat-bubble-user max-w-[88%] rounded-2xl bg-card-hover px-4 py-3"
          )}
          onContextMenu={(event) => {
            event.preventDefault();
            void popupTextMenu(window.getSelection()?.toString() ?? "", t);
          }}
        >
          <MarkdownContent source={visibleText} inverted={false} onOpenLocalFile={onOpenLocalFile} />
          {attachments && attachments.length > 0 && (
            <div className={cn("mt-2.5 grid gap-2", attachments.length > 1 && "sm:grid-cols-2")}>
              {attachments.map((attachment) => attachment.kind === "image" && attachment.path ? (
                <figure key={attachment.id ?? attachment.path} className="overflow-hidden rounded-xl border border-line bg-card-hover">
                  <TimelineImage
                    src={artifactUrlForPath(attachment.path)}
                    alt={attachment.name}
                    name={attachment.name}
                    path={attachment.path}
                    className="max-h-72 w-full object-contain"
                  />
                  <figcaption className="truncate px-2.5 py-1.5 text-[11px] opacity-75">{attachment.name}</figcaption>
                </figure>
              ) : (
                <div
                  key={attachment.id ?? attachment.path ?? attachment.name}
                  role={attachment.path ? "button" : undefined}
                  tabIndex={attachment.path ? 0 : undefined}
                  title={attachment.path}
                  onClick={() => {
                    if (attachment.path) openTimelineFile(attachment.path, t, onOpenLocalFile, "external");
                  }}
                  onKeyDown={(event) => {
                    if (attachment.path && (event.key === "Enter" || event.key === " ")) openTimelineFile(attachment.path, t, onOpenLocalFile, "external");
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void popupFileMenu(attachment.path, t);
                  }}
                  className={cn("flex min-w-0 items-center gap-2 rounded-xl border border-line bg-card-hover px-2.5 py-2 transition-colors", attachment.path && "cursor-pointer hover:border-accent/50")}
                >
                  <FileText className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="truncate text-xs">{attachment.name}</span>
                </div>
              ))}
            </div>
          )}
          {streaming && <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-accent align-text-bottom" aria-label={locale === "zh-CN" ? "正在流式生成" : "Streaming"} />}
        </div>
        {!streaming && (
          <div className="absolute right-0 top-full z-10 flex items-center gap-1 rounded-lg bg-card opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100" title={formatDateTime(event.timestamp, locale)}>
            {editedAt && <span className="text-xs text-ink-3">{locale === "zh-CN" ? "已编辑" : "Edited"}</span>}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(text).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1400);
                });
              }}
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-card-hover hover:text-ink"
              aria-label={locale === "zh-CN" ? "复制" : "Copy"}
              title={locale === "zh-CN" ? "复制" : "Copy"}
            >
              {copied ? <Check className="h-3.5 w-3.5 text-ok" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
            </button>
            {isUser && messageId && onEditMessage && (
              <button
                type="button"
                onClick={() => onEditMessage(messageId, text)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-card-hover hover:text-ink"
                aria-label={locale === "zh-CN" ? "编辑" : "Edit"}
                title={locale === "zh-CN" ? "编辑" : "Edit"}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function ActivityLine({ event, locale }: { event: TimelineEvent & { data: { kind: "activity" } }; locale: "zh-CN" | "en-US" }): JSX.Element | null {
  if (event.data.phase !== "starting") return null;
  return (
    <details className="text-[13px] text-ink-3">
      <summary className="w-fit cursor-pointer rounded-md py-1 outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
        {locale === "zh-CN" ? "会话已初始化" : "Initialized session"}
      </summary>
      <time className="mt-1 block text-xs">{formatDateTime(event.timestamp, locale)}</time>
    </details>
  );
}

function ReasoningCard({ event, locale }: { event: TimelineEvent & { data: { kind: "reasoning" } }; locale: "zh-CN" | "en-US" }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const reasoningScrollRef = useRef<HTMLDivElement>(null);
  const visibleText = useStreamingText(event.data.text, Boolean(event.data.streaming), `${event.sessionId}:${event.id}`);
  const followReasoningRef = useRef(true);
  const zh = locale === "zh-CN";
  const scrollToLatest = useCallback(() => {
    const element = reasoningScrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    followReasoningRef.current = true;
    setShowJumpToLatest(false);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    followReasoningRef.current = true;
    setShowJumpToLatest(false);
    scrollToLatest();
  }, [open, scrollToLatest]);

  // Streaming text replaces the reasoning event on every delta. Keep the
  // viewport pinned only while the user is already at the tail; a manual
  // upward scroll opts out until they return to the bottom.
  useLayoutEffect(() => {
    if (open && event.data.streaming && followReasoningRef.current) scrollToLatest();
  }, [event.data.streaming, visibleText, open, scrollToLatest]);

  const handleReasoningScroll = (): void => {
    const element = reasoningScrollRef.current;
    if (!element) return;
    const atLatest = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_TAIL_THRESHOLD;
    followReasoningRef.current = atLatest;
    setShowJumpToLatest(!atLatest);
  };

  return (
    <motion.article initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="reasoning-card">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex max-w-full items-center gap-2 rounded-md py-1 text-left text-[13px] text-ink-3 outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <span className="font-normal">
          {event.data.streaming ? (zh ? "推理中" : "Reasoning") : (zh ? "推理完成" : "Reasoning complete")}
        </span>
        {event.data.streaming && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" aria-hidden />}
        <ChevronDown className={cn("h-3.5 w-3.5 text-ink-3 transition-transform duration-200", !open && "-rotate-90")} aria-hidden />
      </button>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          onAnimationComplete={scrollToLatest}
          className="overflow-hidden"
        >
          <div className="relative">
            <div
              ref={reasoningScrollRef}
              onScroll={handleReasoningScroll}
              className="mt-2 max-h-96 overscroll-contain overflow-y-auto rounded-xl border border-line px-3.5 py-3 text-[13px] leading-relaxed text-ink-2"
            >
              <MarkdownContent source={visibleText} />
              {event.data.streaming && <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-accent align-text-bottom" aria-hidden />}
            </div>
            <AnimatePresence>
              {showJumpToLatest && (
                <motion.button
                  type="button"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                  onClick={scrollToLatest}
                  className="absolute bottom-2 right-3 inline-flex items-center gap-1 rounded-full border border-line bg-card px-2 py-1 text-[11px] text-ink-2 shadow-pop transition-colors hover:bg-card-hover"
                  aria-label={zh ? "滚动到最新推理" : "Scroll to latest reasoning"}
                >
                  <ChevronDown className="h-3 w-3" aria-hidden />
                  {zh ? "回到底部" : "Latest"}
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </motion.article>
  );
}

function ToolActivityCard({ event, locale }: { event: TimelineEvent & { data: { kind: "tool_activity" } }; locale: "zh-CN" | "en-US" }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { toolName, status, input, output, fileDiff } = event.data;
  const resolvedFileDiff = useMemo(() => fileDiff ?? toolInputFileDiff(toolName, input), [fileDiff, toolName, input]);
  const counts = useMemo(() => {
    if (!resolvedFileDiff) return undefined;
    const rows = diffLines(resolvedFileDiff.before, resolvedFileDiff.after);
    return { additions: rows.filter((row) => row.type === "added").length, deletions: rows.filter((row) => row.type === "removed").length };
  }, [resolvedFileDiff]);
  const details = Boolean(resolvedFileDiff || input || output);
  const zh = locale === "zh-CN";
  const label = toolActivityLabel(toolName, status, input, locale);
  return (
    <article className="text-[13px]">
      <button
        type="button"
        disabled={!details}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={details ? open : undefined}
        className="flex max-w-full items-center gap-2 rounded-md py-1 text-left text-ink-3 outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-default"
      >
        {status === "running" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />}
        {status === "failed" && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />}
        <span className="truncate" title={label}>{label}</span>
        {counts && <span className="flex shrink-0 gap-1.5 tabular-nums"><span className="text-ok">+{counts.additions}</span><span className="text-danger">−{counts.deletions}</span></span>}
        {details && <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", !open && "-rotate-90")} aria-hidden />}
      </button>
      {details && open && (
        <div className="mt-2 overflow-hidden rounded-xl border border-line bg-card">
          {resolvedFileDiff && <ToolFileDiffView diff={resolvedFileDiff} locale={locale} />}
          {input && !resolvedFileDiff && <pre className="max-h-40 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2">{input}</pre>}
          {input && resolvedFileDiff && (
            <details className="border-t border-line">
              <summary className="cursor-pointer px-3 py-2 text-xs text-ink-3">{zh ? "原始输入" : "Raw input"}</summary>
              <pre className="max-h-40 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap text-ink-2">{input}</pre>
            </details>
          )}
          {output && <pre className={cn("max-h-56 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2", (input || resolvedFileDiff) && "border-t border-line")}>{output}</pre>}
        </div>
      )}
    </article>
  );
}

function UsageLine({ event, locale }: { event: TimelineEvent & { data: { kind: "usage" } }; locale: "zh-CN" | "en-US" }): JSX.Element {
  const zh = locale === "zh-CN";
  return (
    <p className="text-right font-mono text-[11px] text-ink-3">
      {zh ? "Token" : "Tokens"}: {event.data.inputTokens ?? 0} in / {event.data.outputTokens ?? 0} out
    </p>
  );
}

/** A provider CLI's native sub-agent dispatch, rendered like our own delegation cards. */
function SubagentCard({ event, locale, onOpenSubagent }: { event: TimelineEvent & { data: { kind: "tool_activity" } }; locale: "zh-CN" | "en-US"; onOpenSubagent?: (eventId: string) => void }): JSX.Element {
  const { t } = useI18n();
  const { status, subagent } = event.data;
  const tone = status === "running" ? "accent" : status === "done" ? "ok" : "danger";
  const statusLabel = status === "running"
    ? subagent?.background ? t("sessions.cards.subagentBackgroundRunning") : t("sessions.cards.running")
    : status === "done"
      ? t("sessions.status.completed")
      : t("sessions.cards.failed");
  const activityCount = subagent?.activities?.length ?? 0;
  return (
    <CardShell
      icon={Bot}
      tone="info"
      title={
        <span className="inline-flex min-w-0 items-center gap-2 text-[13px]">
          <span className="shrink-0 text-ink-3">{t("sessions.cards.subagent")}</span>
          {subagent?.agentType && <Tag label={subagent.agentType} />}
          {subagent?.background && <Tag label={t("sessions.cards.subagentBackground")} />}
          <StatusChip tone={tone} label={statusLabel} pulse={status === "running"} className="h-5 shrink-0 px-1.5 text-[10px]" />
          {onOpenSubagent && (
            <button
              type="button"
              onClick={() => onOpenSubagent(event.id)}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium text-accent transition-colors hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
            >
              {activityCount > 0 ? t("sessions.cards.subagentDetailCount", { count: activityCount }) : t("sessions.cards.subagentDetail")} →
            </button>
          )}
        </span>
      }
      time={formatDateTime(event.timestamp, locale)}
    >
      {subagent?.task && (
        <p className="rounded-xl border border-line bg-card px-3.5 py-2.5 text-[13px] leading-relaxed break-all whitespace-pre-wrap text-ink-2">
          {subagent.task}
        </p>
      )}
    </CardShell>
  );
}

function ArtifactCard({ event, locale, onOpenLocalFile }: {
  event: TimelineEvent & { data: { kind: "artifact" } };
  locale: "zh-CN" | "en-US";
  onOpenLocalFile?: (path: string) => void;
}): JSX.Element {
  const { artifactType, name, mimeType, content, path } = event.data;
  const { t } = useI18n();
  const source = artifactType === "image"
    ? content?.startsWith("data:")
      ? content
      : content
        ? `data:${mimeType ?? "image/png"};base64,${content}`
        : path
          ? artifactUrlForPath(path)
          : undefined
    : undefined;
  return (
    <CardShell
      icon={ImageIcon}
      tone="info"
      title={artifactType === "image" ? (locale === "zh-CN" ? "生成的图片" : "Generated image") : name}
      time={formatDateTime(event.timestamp, locale)}
    >
      {source ? (
        <figure className="overflow-hidden rounded-xl border border-line bg-card">
          <TimelineImage src={source} alt={name} name={name} path={path} className="max-h-[520px] w-full object-contain" />
          <figcaption className="border-t border-line px-3 py-2 text-xs text-ink-3">{name}</figcaption>
        </figure>
      ) : (
        <p
          role={path ? "button" : undefined}
          tabIndex={path ? 0 : undefined}
          title={path}
          onClick={() => {
            if (path) openTimelineFile(path, t, onOpenLocalFile, "external");
          }}
          onKeyDown={(event) => {
            if (path && (event.key === "Enter" || event.key === " ")) openTimelineFile(path, t, onOpenLocalFile, "external");
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void popupFileMenu(path, t);
          }}
          className={cn("rounded-xl border border-line bg-card px-3 py-2 font-mono text-xs text-ink-2 transition-colors", path && "cursor-pointer hover:border-accent/50")}
        >
          {path ?? name}
        </p>
      )}
    </CardShell>
  );
}

function PlannerDecisionCard({ event, t, locale }: { event: TimelineEvent & { data: { kind: "planner_decision" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string }): JSX.Element {
  const modeTone = { direct: "ok", delegate: "info", plan: "accent" } as const;
  return (
    <CardShell
      icon={GitBranch}
      tone={modeTone[event.data.mode]}
      title={<StatusChip tone={modeTone[event.data.mode]} label={t(`sessions.cards.decision.${event.data.mode}` as MessageKey)} />}
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <p className="rounded-xl border border-line bg-card px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-2">
        {event.data.rationale}
      </p>
    </CardShell>
  );
}

function RecoveryDecisionCard({ event, locale }: { event: TimelineEvent & { data: { kind: "recovery_decision" } }; locale: string }): JSX.Element {
  return (
    <CardShell
      icon={GitBranch}
      tone={event.data.action === "retry" ? "info" : event.data.action === "take_over" ? "accent" : "warn"}
      title={`Failure recovery · ${event.data.action}`}
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <p className="rounded-xl border border-line bg-card px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-2">
        {event.data.rationale}
      </p>
    </CardShell>
  );
}

function TaskUpdateCard({ event, t, locale, onOpenSession }: { event: TimelineEvent & { data: { kind: "task_update" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string; onOpenSession?: (id: string) => void }): JSX.Element {
  const statusTone: Record<string, "muted" | "info" | "accent" | "ok" | "danger" | "warn"> = {
    queued: "muted",
    running: "accent",
    completed: "ok",
    failed: "danger",
    cancelled: "muted",
    blocked_dependency: "warn",
    verifying: "info"
  };
  return (
    <CardShell
      icon={ClipboardList}
      tone={statusTone[event.data.status] ?? "muted"}
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="truncate">{event.data.memberName ? (locale === "zh-CN" ? `已委派给 ${event.data.memberName}` : `Delegated to ${event.data.memberName}`) : event.data.title}</span>
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card px-3.5 py-2.5">
        <span className="min-w-0 truncate text-[13px] text-ink-2">{event.data.title}</span>
        <span className="inline-flex shrink-0 items-center gap-2">
          <StatusChip
            tone={statusTone[event.data.status] ?? "muted"}
            label={t(`sessions.taskStatus.${event.data.status}` as MessageKey)}
            pulse={event.data.status === "running"}
          />
          {event.data.sessionId && onOpenSession && (
            <button
              type="button"
              onClick={() => onOpenSession(event.data.sessionId!)}
              className="rounded-md px-1.5 py-0.5 text-xs font-medium text-accent transition-colors hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
            >
              {t("sessions.cards.openSub")}
            </button>
          )}
        </span>
      </div>
    </CardShell>
  );
}

function commandPresentation(command: string): { summary: string; full: string } {
  const full = command.replaceAll("\\\\", "\\").replace(/\s+/g, " ").trim();
  const executableMatch = full.match(/^"([^"]+)"|^(\S+)/);
  const executable = (executableMatch?.[1] ?? executableMatch?.[2] ?? "command").split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "") ?? "command";
  const commandBody = full.match(/(?:^|\s)-(?:Command|c)\s+(.+)$/i)?.[1]?.replace(/^"|"$/g, "")
    ?? full.slice(executableMatch?.[0].length ?? 0).trim();
  const targetPath = commandBody.match(/-(?:LiteralPath|Path)\s+['"]([^'"]+)['"]/i)?.[1];
  const operation = commandBody.match(/^([\w-]+)/)?.[1];
  const targetName = targetPath?.split(/[\\/]/).at(-1);
  const label = targetName
    ? [executable, operation, targetName].filter(Boolean).join(" · ")
    : commandBody ? `${executable} · ${commandBody}` : executable;
  return { full, summary: label.length > 96 ? `${label.slice(0, 93)}…` : label };
}

function CommandCard({ event, t, locale }: { event: TimelineEvent & { data: { kind: "command" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { command, status, exitCode, output, attempts = 1 } = event.data;
  const presented = commandPresentation(command);
  const zh = locale === "zh-CN";
  return (
    <article>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
        className="flex max-w-full items-center gap-2 rounded-md py-1 text-left text-[13px] text-ink-3 outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50">
        {status === "running" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-label={t("sessions.cards.running")} />}
        {status === "failed" && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />}
        <span className="truncate" title={presented.full}>{zh ? "运行" : "Ran"} {presented.summary}</span>
        {attempts > 1 && <span className="shrink-0 text-xs">{zh ? `${attempts} 次` : `${attempts} attempts`}</span>}
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", !open && "-rotate-90")} aria-hidden />
      </button>
      {open && (
        <div className="mt-2 max-h-72 overflow-auto rounded-xl border border-line bg-card">
          <pre className="px-3.5 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-ink-2">{presented.full}</pre>
          {output && <pre className="border-t border-line px-3.5 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-ink-2">{output}</pre>}
          {exitCode !== undefined && <p className={cn("border-t border-line px-3.5 py-2 text-xs", exitCode === 0 ? "text-ink-3" : "text-danger")}>{t("sessions.cards.exitCode", { code: exitCode })}</p>}
        </div>
      )}
    </article>
  );
}

function FileChangeCard({
  event,
  t,
  locale,
  onViewDiff,
  onOpenLocalFile
}: {
  event: TimelineEvent & { data: { kind: "file_change" } };
  t: (k: MessageKey, v?: Record<string, string | number>) => string;
  locale: string;
  onViewDiff?: (path?: string) => void;
  onOpenLocalFile?: (path: string) => void;
}): JSX.Element {
  const { files } = event.data;
  return (
    <ul className="overflow-hidden rounded-xl border border-line bg-card">
      {event.data.source === "provider" && (
        <li className="border-b border-line px-3.5 py-2 text-xs text-ink-3">
          {locale === "zh-CN" ? `本轮原生差异 · ${files.length} 个文件` : `Provider turn diff · ${files.length} files`}
        </li>
      )}
      {files.map((file) => {
        const counts = fileChangeCounts(file);
        const open = (): void => {
          if (onViewDiff && (file.diff || !onOpenLocalFile)) onViewDiff(file.path);
          else openTimelineFile(file.path, t, onOpenLocalFile, "drawer");
        };
        return (
          <li key={file.path} className="border-b border-line last:border-0">
            <button type="button" title={file.path} onClick={open}
              className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left text-[13px] outline-none transition-colors hover:bg-card-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50">
              <FileCode2 className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-ink-2">{file.path}</span>
              {file.comparisonUnavailable
                ? <span className="shrink-0 text-xs text-ink-3" title={file.reason}>{locale === "zh-CN" ? "无法比较" : "Unavailable"}</span>
                : <span className="flex shrink-0 gap-1.5 tabular-nums"><span className="text-ok">+{counts.additions}</span><span className="text-danger">−{counts.deletions}</span></span>}
              <ChevronDown className="h-3.5 w-3.5 -rotate-90 text-ink-3" aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function VerificationCard({ event, t, locale }: { event: TimelineEvent & { data: { kind: "verification" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { command, status, durationMs, log } = event.data;
  return (
    <CardShell
      icon={FlaskConical}
      tone={status === "failed" ? "danger" : status === "passed" ? "ok" : "accent"}
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="shrink-0">{t("sessions.cards.verification")}</span>
          <code className="truncate font-mono text-xs text-ink-3">{command}</code>
          {status === "running" ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" aria-label={t("sessions.cards.running")} />
          ) : (
            <StatusChip tone={status === "passed" ? "ok" : "danger"} label={t(status === "passed" ? "sessions.cards.passed" : "sessions.cards.failed")} />
          )}
          {durationMs !== undefined && status !== "running" && (
            <span className="shrink-0 font-mono text-[11px] text-ink-3">
              {t("sessions.cards.duration", { seconds: (durationMs / 1000).toFixed(1) })}
            </span>
          )}
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      {log && (
        <div className="rounded-xl border border-line bg-card">
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
            className="flex w-full items-center justify-between gap-2 px-3.5 py-2 text-xs text-ink-3 transition-colors hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
          >
            <span>{t("sessions.cards.log")}</span>
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", open && "rotate-180")} aria-hidden />
          </button>
          {open && (
            <pre className="max-h-56 overflow-auto border-t border-line px-3.5 py-2.5 font-mono text-xs leading-relaxed text-ink-2">
              {log}
            </pre>
          )}
        </div>
      )}
    </CardShell>
  );
}

function GitMergeCard({ event, locale }: { event: TimelineEvent & { data: { kind: "git_merge" } }; locale: string }): JSX.Element {
  const { status, sourceBranch, targetBranch, commit, paths } = event.data;
  const zh = locale === "zh-CN";
  const labels = {
    running: zh ? "合并中" : "Merging",
    completed: zh ? "已合并" : "Merged",
    conflict: zh ? "存在冲突" : "Conflict"
  } as const;
  return (
    <CardShell
      icon={GitBranch}
      tone={status === "conflict" ? "danger" : status === "completed" ? "ok" : "accent"}
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span>{zh ? "Git 合并" : "Git merge"}</span>
          <StatusChip tone={status === "conflict" ? "danger" : status === "completed" ? "ok" : "accent"} label={labels[status]} pulse={status === "running"} />
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <div className="space-y-2 rounded-xl border border-line bg-card px-3.5 py-2.5 text-[13px] text-ink-2">
        <p className="font-mono break-all">{sourceBranch} → {targetBranch}</p>
        {commit && <p className="font-mono text-xs text-ink-3">commit {commit}</p>}
        {paths && paths.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-danger">{zh ? "冲突文件" : "Conflicted files"}</p>
            <ul className="space-y-1 font-mono text-xs text-danger">
              {paths.map((path) => <li key={path}>{path}</li>)}
            </ul>
          </div>
        )}
      </div>
    </CardShell>
  );
}

const SCOPES: ApprovalScope[] = ["once", "run", "task", "project", "global"];

function ApprovalCard({ event, t, locale }: { event: TimelineEvent & { data: { kind: "approval" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string }): JSX.Element {
  const { approval } = event.data;
  const [scope, setScope] = useState<ApprovalScope>(approval.kind === "merge" ? "project" : approval.kind === "delegate" ? "run" : "once");
  const pending = approval.status === "pending";
  return (
    <CardShell
      icon={AlertTriangle}
      tone="warn"
      title={
        <span className="inline-flex items-center gap-2">
          {t("sessions.cards.approval")}
          <StatusChip
            tone={pending ? "warn" : approval.status === "approved" ? "ok" : "danger"}
            label={t(pending ? "sessions.status.waiting_approval" : approval.status === "approved" ? "sessions.cards.approved" : "sessions.cards.rejected")}
            pulse={pending}
          />
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <div className="rounded-xl border border-line bg-panel px-5 py-4">
        <p className="text-sm font-medium text-ink">{approval.title}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{approval.description}</p>
        {pending && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-line bg-card p-0.5" role="radiogroup" aria-label={t("sessions.cards.scope")}>
              {SCOPES.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={scope === item}
                  onClick={() => setScope(item)}
                  className={cn(
                    "h-7 rounded-md px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                    scope === item ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink-2"
                  )}
                >
                  {t(`sessions.cards.scope${item[0].toUpperCase()}${item.slice(1)}` as MessageKey)}
                </button>
              ))}
            </div>
            <Button variant="primary" size="sm" onClick={() => void resolveWorkbenchApproval(event.sessionId, approval.id, true, scope)}>
              <Check className="h-3.5 w-3.5" aria-hidden />
              {t("sessions.cards.approve")}
            </Button>
            <Button variant="danger" size="sm" onClick={() => void resolveWorkbenchApproval(event.sessionId, approval.id, false, scope)}>
              <X className="h-3.5 w-3.5" aria-hidden />
              {t("sessions.cards.reject")}
            </Button>
          </div>
        )}
      </div>
    </CardShell>
  );
}

function ErrorCard({ event, t, locale }: { event: TimelineEvent & { data: { kind: "error" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string }): JSX.Element {
  return (
    <CardShell
      icon={AlertTriangle}
      tone="danger"
      title={
        <span className="inline-flex items-center gap-2">
          {t("sessions.cards.error")}
          <code className="rounded bg-danger/10 px-1.5 py-0.5 font-mono text-[11px] text-danger">{event.data.code}</code>
          <StatusChip tone={event.data.retryable ? "info" : "muted"} label={t(event.data.retryable ? "sessions.cards.retryable" : "sessions.cards.notRetryable")} />
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <p className="rounded-xl border border-danger/25 bg-danger/5 px-3.5 py-2.5 text-[13px] break-all whitespace-pre-wrap text-ink-2">
        {event.data.message}
      </p>
    </CardShell>
  );
}

function HandoffCard({ event, t, locale, onOpenSession }: { event: TimelineEvent & { data: { kind: "handoff" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string; onOpenSession?: (id: string) => void }): JSX.Element {
  return (
    <CardShell
      icon={ArrowRightLeft}
      tone="info"
      title={
        <span className="inline-flex min-w-0 items-center gap-2 text-[13px]">
          <span className="shrink-0 text-ink-3">{t("sessions.cards.handoff")}</span>
          <Tag label={event.data.fromName} />
          <span aria-hidden className="text-ink-3">→</span>
          <Tag label={event.data.toName} />
          {event.data.sessionId && onOpenSession && (
            <button
              type="button"
              onClick={() => onOpenSession(event.data.sessionId!)}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium text-accent transition-colors hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
            >
              {t("sessions.cards.openSub")} →
            </button>
          )}
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <p className="rounded-xl border border-line bg-card px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-2">
        {event.data.summary}
      </p>
    </CardShell>
  );
}

function TimelineEventViewImpl({
  event,
  onViewDiff,
  onOpenSession,
  onEditMessage,
  onOpenSubagent,
  onOpenLocalFile
}: {
  event: TimelineEvent;
  onViewDiff?: (path?: string) => void;
  onOpenSession?: (id: string) => void;
  onEditMessage?: (messageId: string, text: string) => void;
  onOpenSubagent?: (eventId: string) => void;
  /** Work mode only: local file clicks route to the session's preview pane. */
  onOpenLocalFile?: (path: string) => void;
}): JSX.Element | null {
  const { t, locale } = useI18n();
  const data = event.data;

  switch (data.kind) {
    case "message":
      return <MessageCard event={event as TimelineEvent & { data: Extract<TimelineEvent["data"], { kind: "message" }> }} locale={locale} onEditMessage={onEditMessage} onOpenLocalFile={onOpenLocalFile} />;
    case "activity":
      return <ActivityLine event={event as TimelineEvent & { data: { kind: "activity" } }} locale={locale} />;
    case "reasoning":
      return <ReasoningCard event={event as TimelineEvent & { data: { kind: "reasoning" } }} locale={locale} />;
    case "tool_activity":
      if (data.subagent) return <SubagentCard event={event as TimelineEvent & { data: { kind: "tool_activity" } }} locale={locale} onOpenSubagent={onOpenSubagent} />;
      return <ToolActivityCard event={event as TimelineEvent & { data: { kind: "tool_activity" } }} locale={locale} />;
    case "tool_group":
      return <div className="space-y-3">{data.items.map((item) => <TimelineEventView key={item.id} event={item} onViewDiff={onViewDiff} onOpenSession={onOpenSession} onOpenSubagent={onOpenSubagent} onOpenLocalFile={onOpenLocalFile} />)}</div>;
    case "usage":
      return <UsageLine event={event as TimelineEvent & { data: { kind: "usage" } }} locale={locale} />;
    case "artifact":
      return <ArtifactCard event={event as TimelineEvent & { data: { kind: "artifact" } }} locale={locale} onOpenLocalFile={onOpenLocalFile} />;
    case "planner_decision":
      return <PlannerDecisionCard event={event as TimelineEvent & { data: { kind: "planner_decision" } }} t={t} locale={locale} />;
    case "recovery_decision":
      return <RecoveryDecisionCard event={event as TimelineEvent & { data: { kind: "recovery_decision" } }} locale={locale} />;
    case "task_update":
      return <TaskUpdateCard event={event as TimelineEvent & { data: { kind: "task_update" } }} t={t} locale={locale} onOpenSession={onOpenSession} />;
    case "command":
      return <CommandCard event={event as TimelineEvent & { data: { kind: "command" } }} t={t} locale={locale} />;
    case "file_change":
      return <FileChangeCard event={event as TimelineEvent & { data: { kind: "file_change" } }} t={t} locale={locale} onViewDiff={onViewDiff} onOpenLocalFile={onOpenLocalFile} />;
    case "verification":
      return <VerificationCard event={event as TimelineEvent & { data: { kind: "verification" } }} t={t} locale={locale} />;
    case "git_merge":
      return <GitMergeCard event={event as TimelineEvent & { data: { kind: "git_merge" } }} locale={locale} />;
    case "approval":
      return <ApprovalCard event={event as TimelineEvent & { data: { kind: "approval" } }} t={t} locale={locale} />;
    case "error":
      return <ErrorCard event={event as TimelineEvent & { data: { kind: "error" } }} t={t} locale={locale} />;
    case "handoff":
      return <HandoffCard event={event as TimelineEvent & { data: { kind: "handoff" } }} t={t} locale={locale} onOpenSession={onOpenSession} />;
    case "run_status":
      if (data.run.status === "completed") return null;
      return (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="log-line py-0.5 text-center text-ink-3">
          — {t(`sessions.status.${data.run.status === "waiting_approval" ? "waiting_approval" : data.run.status}` as MessageKey)}
          {data.run.reason ? ` · ${data.run.reason}` : ""} · {formatDateTime(event.timestamp, locale)} —
        </motion.p>
      );
    case "approval_resolved":
      return (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="log-line py-0.5 text-center text-ink-3">
          — {t(data.decision === "approved" ? "sessions.cards.approved" : "sessions.cards.rejected")} · {formatDateTime(event.timestamp, locale)} —
        </motion.p>
      );
    case "checkpoint_reverted":
      return (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="log-line py-0.5 text-center text-ink-3">
          — {t("sessions.checkpoint.reverted", { restored: data.restored.length, removed: data.removed.length })}
          {data.warning ? ` · ${t("sessions.checkpoint.truncatedWarning")}` : ""} · {formatDateTime(event.timestamp, locale)} —
        </motion.p>
      );
    default:
      return null;
  }
}

// Memoized on event identity: streaming deltas replace only the live event
// object, so historical rows skip re-render (and markdown re-parse) entirely.
// Callback props are stable dispatchers by convention. Locale switches still
// re-render through the i18n context, bypassing this memo.
export const TimelineEventView = memo(
  TimelineEventViewImpl,
  (prev, next) => prev.event === next.event
    && prev.onViewDiff === next.onViewDiff
    && prev.onOpenSession === next.onOpenSession
    && prev.onEditMessage === next.onEditMessage
    && prev.onOpenSubagent === next.onOpenSubagent
    && prev.onOpenLocalFile === next.onOpenLocalFile
);
