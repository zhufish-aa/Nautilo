import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRightLeft,
  Bot,
  BrainCircuit,
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
  RotateCcw,
  Sparkles,
  SquareTerminal,
  User,
  Wrench,
  X
} from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { cn, formatDateTime } from "../../lib/utils";
import type { ApprovalScope, TimelineEvent } from "../../lib/types";
import { StatusChip, Tag } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { resolveWorkbenchApproval } from "../../lib/orchestration-runtime";
import { toolActivityLabel, toolInputFileDiff } from "../../lib/tool-display";
import { latestReasoningSummary } from "../../lib/tool-group-preview";
import { MarkdownContent } from "./MarkdownContent";
import { ToolFileDiffView } from "./ToolFileDiffView";
import { TimelineImage } from "./TimelineImage";
import { openFileWithToast, popupFileMenu, popupTextMenu } from "./media-actions";
import { openFilePreview } from "../../stores/file-preview";
import { resolveFileOpenTarget } from "../../lib/file-references";
import { fileChangeCounts } from "../../lib/changed-files";

const FOLLOW_TAIL_THRESHOLD = 120;

/**
 * Owns the vertical viewport for a timeline. TimelineEventView below is a
 * card renderer; this component is the layer that can actually observe and
 * control the scrolling element.
 */
export function TimelineViewport({
  children,
  sessionKey,
  contentKey,
  forceFollowKey,
  active = true,
  className
}: {
  children: ReactNode;
  sessionKey: string;
  contentKey?: unknown;
  forceFollowKey?: string;
  active?: boolean;
  className?: string;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const scrollbarDragRef = useRef(false);
  const scrollbarDragStartTopRef = useRef(0);
  const previousForceFollowKeyRef = useRef(forceFollowKey);

  const scrollToTail = useCallback(() => {
    if (!active || !followTailRef.current) return;
    const element = scrollRef.current;
    if (!element) return;
    // Run after the DOM commit, but do not add another rAF layer: the caller
    // is already a layout effect or ResizeObserver callback. The extra frame
    // was the part that could be skipped while a streaming row was changing.
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
  // The ResizeObserver below covers height changes caused by markdown,
  // images, and framer-motion after the event array itself has rendered.
  useLayoutEffect(() => {
    scrollToTail();
  }, [active, contentKey, scrollToTail]);

  useLayoutEffect(() => {
    if (forceFollowKey === previousForceFollowKeyRef.current) return;
    previousForceFollowKeyRef.current = forceFollowKey;
    if (forceFollowKey === undefined) return;
    followTailRef.current = true;
    scrollToTail();
  }, [forceFollowKey, scrollToTail]);

  useEffect(() => {
    const content = contentRef.current;
    if (!active || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => scrollToTail());
    observer.observe(content);
    return () => observer.disconnect();
  }, [active, scrollToTail]);

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
        if (gap < FOLLOW_TAIL_THRESHOLD) {
          // Reaching the tail by any means re-engages follow mode.
          followTailRef.current = true;
        } else if (scrollbarDragRef.current && element.scrollTop < lastScrollTopRef.current - 1) {
          // A scrollbar thumb dragged upward is explicit user intent.
          followTailRef.current = false;
        }
        lastScrollTopRef.current = element.scrollTop;
      }}
      onWheel={(event) => {
        // Wheel input is the other explicit way to pause follow mode.
        if (event.deltaY < 0) followTailRef.current = false;
      }}
      onPointerDownCapture={(event) => {
        const element = event.currentTarget;
        scrollbarDragRef.current =
          element.scrollHeight > element.clientHeight &&
          event.clientX >= element.getBoundingClientRect().right - 14;
        scrollbarDragStartTopRef.current = element.scrollTop;
      }}
      onPointerUpCapture={() => {
        const element = scrollRef.current;
        if (element && scrollbarDragRef.current) {
          const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
          if (gap < FOLLOW_TAIL_THRESHOLD) followTailRef.current = true;
          else if (element.scrollTop < scrollbarDragStartTopRef.current - 1) followTailRef.current = false;
        }
        scrollbarDragRef.current = false;
      }}
      style={{ overflowAnchor: "none" }}
      className={cn("relative h-full overflow-y-auto", className)}
      aria-live="polite"
    >
      <div ref={contentRef}>{children}</div>
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

function LatestActivityLabel({
  label,
  followTail
}: {
  label: string;
  followTail: boolean;
}): JSX.Element {
  const labelRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const element = labelRef.current;
    if (!element) return;
    element.scrollLeft = followTail ? element.scrollWidth : 0;
  }, [followTail, label]);

  return (
    <span
      ref={labelRef}
      className={cn(
        "min-w-0 flex-1 whitespace-nowrap font-mono",
        followTail ? "overflow-hidden" : "truncate"
      )}
      title={label}
    >
      {label}
    </span>
  );
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
  const toneClasses: Record<string, string> = {
    accent: "border-accent/25 bg-gradient-to-br from-accent/20 via-accent-soft to-info/10 text-accent shadow-[0_3px_10px_-3px_var(--accent-soft)]",
    ok: "border-ok/20 bg-ok/10 text-ok",
    warn: "border-warn/20 bg-warn/10 text-warn",
    danger: "border-danger/20 bg-danger/10 text-danger",
    info: "border-info/20 bg-info/10 text-info",
    muted: "border-line bg-card-hover text-ink-3"
  };
  return (
    <motion.article
      initial={{ opacity: 0, y: 14, scale: 0.985, filter: "blur(5px)" }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
      transition={{ type: "spring", stiffness: 320, damping: 28 }}
      className={cn("flex gap-3", className)}
    >
      <span
        aria-hidden
        className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border", toneClasses[tone])}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        {(title || time) && (
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <div className="min-w-0 text-[13px] font-medium text-ink-2">{title}</div>
            {time && <time className="shrink-0 text-[11px] text-ink-3">{time}</time>}
          </div>
        )}
        {children}
      </div>
    </motion.article>
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
      transition={{ type: "spring", stiffness: 320, damping: 28 }}
      className="group flex"
    >
      <div className={cn("min-w-0 flex-1", isUser && "flex flex-col items-end")}>
        <div className={cn("flex items-baseline gap-2 text-ink-3", isUser && "flex-row-reverse")}>
          <span className={cn("text-[11px] font-medium tracking-wide", isUser && "text-accent")}>
            {isUser ? (locale === "zh-CN" ? "你" : "You") : authorName ?? "Agent"}
          </span>
          <time className="text-[10px] tabular-nums opacity-70">{formatDateTime(event.timestamp, locale)}</time>
          {editedAt && <span className="text-[10px] opacity-70">{locale === "zh-CN" ? "已编辑" : "Edited"}</span>}
        </div>
        <div
          className={cn(
            "mt-1.5 text-[15px] leading-7 text-ink",
            isUser && "chat-bubble-user max-w-[85%] rounded-2xl rounded-tr-md border border-accent/20 bg-accent-soft/60 px-4 py-2.5"
          )}
          onContextMenu={(event) => {
            event.preventDefault();
            void popupTextMenu(window.getSelection()?.toString() ?? "", t);
          }}
        >
          <MarkdownContent source={text} inverted={false} onOpenLocalFile={onOpenLocalFile} />
          {attachments && attachments.length > 0 && (
            <div className={cn("mt-2.5 grid gap-2", attachments.length > 1 && "sm:grid-cols-2")}>
              {attachments.map((attachment) => attachment.kind === "image" && attachment.path ? (
                <figure key={attachment.id ?? attachment.path} className="overflow-hidden rounded-xl border border-line bg-card-hover">
                  <TimelineImage
                    src={`agenthub-artifact://local/?path=${encodeURIComponent(attachment.path)}`}
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
          <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
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
  const zh = locale === "zh-CN";
  const labels = zh
    ? { queued: "请求已发送", starting: "正在启动 Agent", thinking: "正在思考", responding: "正在整理回复", completed: "本轮已完成" }
    : { queued: "Request sent", starting: "Starting agent", thinking: "Thinking", responding: "Preparing response", completed: "Turn completed" };
  const time = formatDateTime(event.timestamp, locale);
  // Turn-completion dividers are hidden: the fold row already marks the end.
  if (event.data.phase === "completed") {
    return null;
  }
  return (
    <motion.div initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="log-line flex items-center gap-2 py-0.5 text-ink-3">
      <span className="relative mx-1 flex h-1.5 w-1.5" aria-hidden>
        <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-70 motion-safe:animate-[pulse-ring_1.6s_ease-out_infinite]" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-gradient-to-br from-accent to-info" />
      </span>
      <span className="shimmer-text">{labels[event.data.phase]}</span>
      <time className="text-[10px] tabular-nums opacity-70">{time}</time>
    </motion.div>
  );
}

function ReasoningCard({ event, locale }: { event: TimelineEvent & { data: { kind: "reasoning" } }; locale: "zh-CN" | "en-US" }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const reasoningScrollRef = useRef<HTMLDivElement>(null);
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
  }, [event.data.streaming, event.data.text, open, scrollToLatest]);

  const handleReasoningScroll = (): void => {
    const element = reasoningScrollRef.current;
    if (!element) return;
    const atLatest = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_TAIL_THRESHOLD;
    followReasoningRef.current = atLatest;
    setShowJumpToLatest(!atLatest);
  };

  return (
    <motion.article initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="reasoning-card rounded-xl border border-line bg-card/70">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[13px] text-ink-2 outline-none transition-colors hover:bg-card-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45"
      >
        <BrainCircuit className="h-4 w-4 shrink-0 text-accent" aria-hidden />
        <span className={cn("font-medium", event.data.streaming && "shimmer-text")}>
          {event.data.streaming ? (zh ? "推理中" : "Reasoning") : (zh ? "推理完成" : "Reasoning complete")}
        </span>
        {event.data.streaming && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" aria-hidden />}
        <ChevronDown className={cn("ml-auto h-3.5 w-3.5 text-ink-3 transition-transform duration-200", open && "rotate-180")} aria-hidden />
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
              className="max-h-96 overscroll-contain overflow-y-auto border-t border-line px-3.5 py-3 pr-2 text-[13px] leading-relaxed text-ink-2"
            >
              <MarkdownContent source={event.data.text} />
              {event.data.streaming && <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-accent align-text-bottom" aria-hidden />}
            </div>
            {showJumpToLatest && (
              <button
                type="button"
                onClick={scrollToLatest}
                className="absolute bottom-2 right-3 inline-flex items-center gap-1 rounded-full border border-line bg-card px-2 py-1 text-[11px] text-ink-2 shadow-pop transition-colors hover:bg-card-hover"
                aria-label={zh ? "滚动到最新推理" : "Scroll to latest reasoning"}
              >
                <ChevronDown className="h-3 w-3" aria-hidden />
                {zh ? "回到底部" : "Latest"}
              </button>
            )}
          </div>
        </motion.div>
      )}
    </motion.article>
  );
}

function ToolActivityCard({ event, locale }: { event: TimelineEvent & { data: { kind: "tool_activity" } }; locale: "zh-CN" | "en-US" }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { toolName, status, input, output, fileDiff } = event.data;
  const resolvedFileDiff = fileDiff ?? toolInputFileDiff(toolName, input);
  const details = Boolean(resolvedFileDiff || input || output);
  const zh = locale === "zh-CN";
  const label = toolActivityLabel(toolName, status, input, locale);
  return (
    <motion.article initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2.5 text-[13px]">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-info/10 text-info">
        {status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Wrench className="h-3.5 w-3.5" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          disabled={!details}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center gap-2 py-1 text-left text-ink-2 disabled:cursor-default"
        >
          <span className="truncate font-medium" title={label}>{label}</span>
          {details && <ChevronDown className={cn("ml-auto h-3.5 w-3.5 text-ink-3 transition-transform", open && "rotate-180")} aria-hidden />}
        </button>
        {details && open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} className="mt-1 overflow-hidden rounded-lg border border-line bg-card-hover">
            {resolvedFileDiff && <ToolFileDiffView diff={resolvedFileDiff} locale={locale} />}
            {input && !resolvedFileDiff && (
              <div className="px-3 py-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">{zh ? "输入" : "Input"}</div>
                <pre className="max-h-40 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">{input}</pre>
              </div>
            )}
            {input && resolvedFileDiff && (
              <details className="border-t border-line">
                <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                  {zh ? "原始输入" : "Raw input"}
                </summary>
                <pre className="max-h-40 overflow-auto border-t border-line px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">{input}</pre>
              </details>
            )}
            {output && (
              <div className={cn("px-3 py-2", (input || resolvedFileDiff) && "border-t border-line")}>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">{zh ? "结果" : "Result"}</div>
                <pre className="max-h-56 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">{output}</pre>
              </div>
            )}
          </motion.div>
        )}
      </div>
    </motion.article>
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
          ? `agenthub-artifact://local/?path=${encodeURIComponent(path)}`
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
  // F-028: commands default to collapsed, expand to see output.
  const [open, setOpen] = useState(false);
  const { command, status, exitCode, output, attempts = 1 } = event.data;
  const presented = commandPresentation(command);
  const zh = locale === "zh-CN";
  return (
    <CardShell
      icon={SquareTerminal}
      tone={status === "failed" ? "danger" : status === "running" ? "accent" : "muted"}
      title={
        <span className="flex w-full min-w-0 items-center gap-2 overflow-hidden">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2" title={presented.full}>{presented.summary}</code>
          {attempts > 1 && <Tag label={zh ? `${attempts} 次尝试` : `${attempts} attempts`} className="h-5 shrink-0" />}
          {status === "running" ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" aria-label={t("sessions.cards.running")} />
          ) : (
            exitCode !== undefined && (
              <StatusChip
                tone={exitCode === 0 ? "ok" : "danger"}
                label={t("sessions.cards.exitCode", { code: exitCode })}
              />
            )
          )}
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      {(command || output) && (
        <div className="rounded-xl border border-line bg-card">
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
            className="flex w-full items-center justify-between gap-2 px-3.5 py-2 text-xs text-ink-3 transition-colors hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
          >
            <span>{zh ? "详情" : "Details"}</span>
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", open && "rotate-180")} aria-hidden />
          </button>
          {open && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} className="max-h-72 overflow-auto border-t border-line">
              <div className="px-3.5 py-2.5">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">{zh ? "命令" : "Command"}</div>
                <pre className="overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-ink-2">{presented.full}</pre>
              </div>
              {output && (
                <div className="border-t border-line px-3.5 py-2.5">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">{t("sessions.cards.output")}</div>
                  <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-ink-2">{output}</pre>
                </div>
              )}
            </motion.div>
          )}
        </div>
      )}
    </CardShell>
  );
}

function ToolGroupCard({ event, t, locale, onViewDiff, onOpenLocalFile }: {
  event: TimelineEvent & { data: Extract<TimelineEvent["data"], { kind: "tool_group" }> };
  t: (k: MessageKey, v?: Record<string, string | number>) => string;
  locale: "zh-CN" | "en-US";
  onViewDiff?: (path?: string) => void;
  onOpenLocalFile?: (path: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const { items, stepCount, callCount, running } = event.data;
  const streamingReasoning = items.some(
    (item) => item.data.kind === "reasoning" && item.data.streaming
  );
  const flowRunning = running || streamingReasoning;
  const calls = items.filter((item) => item.data.kind === "tool_activity" || item.data.kind === "command");
  // The compact row represents the newest activity. Tool calls and validation
  // may replace a reasoning preview; when reasoning is newest, its growing text
  // is summarized again on every render.
  const preview = items.at(-1);
  const onlyCommands = calls.every((item) => item.data.kind === "command");
  const hasSupportingSteps = items.some((item) => item.data.kind !== "tool_activity" && item.data.kind !== "command");
  const zh = locale === "zh-CN";
  const title = hasSupportingSteps
    ? flowRunning
      ? zh ? `正在处理 ${stepCount} 个步骤` : `Working through ${stepCount} steps`
      : zh ? `处理了 ${stepCount} 个步骤` : `Completed ${stepCount} steps`
    : flowRunning
      ? zh ? `正在运行 ${callCount} 个${onlyCommands ? "命令" : "工具/命令"}` : `Running ${callCount} ${onlyCommands ? "commands" : "tools/commands"}`
      : zh ? `运行了 ${callCount} 个${onlyCommands ? "命令" : "工具/命令"}` : `Ran ${callCount} ${onlyCommands ? "commands" : "tools/commands"}`;
  const previewStatus = flowRunning
    ? "running"
    : preview?.data.kind === "command" || preview?.data.kind === "tool_activity"
      ? preview.data.status
      : preview?.data.kind === "reasoning"
        ? preview.data.streaming ? "running" : "done"
        : preview?.data.kind === "verification"
          ? preview.data.status === "running" ? "running" : preview.data.status === "failed" ? "failed" : "done"
          : "done";
  const previewLabel = preview?.data.kind === "command"
    ? commandPresentation(preview.data.command).summary
    : preview?.data.kind === "tool_activity"
      ? preview.data.toolName
      : preview?.data.kind === "reasoning"
        ? latestReasoningSummary(preview.data.text)
        : preview?.data.kind === "file_change"
          ? zh
            ? `修改了 ${preview.data.files.length} 个文件 · ${preview.data.files.at(-1)?.path ?? ""}`
            : `Changed ${preview.data.files.length} files · ${preview.data.files.at(-1)?.path ?? ""}`
          : preview?.data.kind === "verification"
            ? preview.data.command
            : "";

  return (
    <motion.article
      initial={{ opacity: 0, y: 10, scale: 0.99, filter: "blur(4px)" }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
      transition={{ type: "spring", stiffness: 320, damping: 28 }}
      className={cn(
        "run-border relative overflow-hidden rounded-xl border bg-card/70 transition-[border-color,box-shadow] duration-700",
        flowRunning
          ? "run-border-active border-accent/30 shadow-[0_14px_44px_-18px_var(--accent)]"
          : "border-line"
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="w-full px-3.5 py-2 text-left outline-none transition-colors hover:bg-card-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45"
      >
        <span className="flex items-center gap-2.5 text-[13px] font-medium text-ink-2">
          {/* Status node: the only glowing element while the track is alive. */}
          {flowRunning ? (
            <span className="relative mx-1 flex h-2 w-2 shrink-0" aria-hidden>
              <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-70 motion-safe:animate-[pulse-ring_1.6s_ease-out_infinite]" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" />
            </span>
          ) : (
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-line text-ok" aria-hidden>
              <Check className="h-2.5 w-2.5" />
            </span>
          )}
          <span className={flowRunning ? "shimmer-text" : undefined}>{title}</span>
          {flowRunning && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" aria-hidden />}
          <ChevronDown className={cn("ml-auto h-3.5 w-3.5 text-ink-3 transition-transform duration-200", open && "rotate-180")} aria-hidden />
        </span>
        {preview && (
          <span className="mt-1.5 flex min-w-0 items-center gap-2 pl-7 font-mono text-[11px] text-ink-3">
            {previewStatus === "running"
              ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent" aria-hidden />
              : previewStatus === "failed"
                ? <X className="h-3 w-3 shrink-0 text-danger" aria-hidden />
                : <Check className="h-3 w-3 shrink-0 text-ok" aria-hidden />}
            <LatestActivityLabel
              label={previewLabel}
              followTail={preview.data.kind === "reasoning"}
            />
            {preview.data.kind === "command" && preview.data.exitCode !== undefined && (
              <span className="ml-auto shrink-0">exit {preview.data.exitCode}</span>
            )}
          </span>
        )}
      </button>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          className="overflow-hidden border-t border-line"
        >
          {/* Workflow rail: steps hang from one quiet hairline. */}
          <div className="relative ml-[21px] space-y-3 border-l border-line py-3 pl-4 pr-3.5">
            {items.map((item) => {
              if (item.data.kind === "reasoning") return <ReasoningCard key={item.id} event={item as TimelineEvent & { data: { kind: "reasoning" } }} locale={locale} />;
              if (item.data.kind === "tool_activity") return <ToolActivityCard key={item.id} event={item as TimelineEvent & { data: { kind: "tool_activity" } }} locale={locale} />;
              if (item.data.kind === "command") return <CommandCard key={item.id} event={item as TimelineEvent & { data: { kind: "command" } }} t={t} locale={locale} />;
              if (item.data.kind === "file_change") return <FileChangeCard key={item.id} event={item as TimelineEvent & { data: { kind: "file_change" } }} t={t} locale={locale} onViewDiff={onViewDiff} onOpenLocalFile={onOpenLocalFile} />;
              if (item.data.kind === "verification") return <VerificationCard key={item.id} event={item as TimelineEvent & { data: { kind: "verification" } }} t={t} locale={locale} />;
              return null;
            })}
          </div>
        </motion.div>
      )}
      <span className={cn("run-beam", flowRunning && "run-beam-active")} aria-hidden />
    </motion.article>
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
    <CardShell
      icon={FileCode2}
      tone="info"
      title={
        <span className="inline-flex items-center gap-2">
          {t("sessions.cards.files", { count: files.length })}
          {onViewDiff && (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onViewDiff(files[0]?.path)}>
              {t("sessions.cards.viewDiff")}
            </Button>
          )}
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <ul className="overflow-hidden rounded-xl border border-line bg-card">
        {files.map((file) => (
          <li
            key={file.path}
            role="button"
            tabIndex={0}
            title={file.path}
            onClick={() => openTimelineFile(file.path, t, onOpenLocalFile, "drawer")}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") openTimelineFile(file.path, t, onOpenLocalFile, "drawer");
            }}
            className="flex cursor-pointer items-center gap-2.5 border-b border-line px-3.5 py-2 transition-colors last:border-0 hover:bg-card-hover"
          >
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full shrink-0",
                file.changeType === "added" ? "bg-ok" : file.changeType === "deleted" ? "bg-danger" : "bg-info"
              )}
              aria-label={file.changeType}
            />
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2" title={file.path}>
              {file.path}
            </code>
            <span className="shrink-0 font-mono text-[11px]">
              <span className="text-ok">+{fileChangeCounts(file).additions}</span>{" "}
              <span className="text-danger">-{fileChangeCounts(file).deletions}</span>
            </span>
          </li>
        ))}
      </ul>
    </CardShell>
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
      <div className="rounded-xl border border-warn/25 bg-warn/5 px-4 py-3">
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
      // Transient per-turn phases (queued/starting/thinking/responding) are already
      // surfaced by the live run indicator; keep only the completed milestone so
      // history isn't littered with repeated "thinking" lines.
      if (data.phase !== "completed") return null;
      return <ActivityLine event={event as TimelineEvent & { data: { kind: "activity" } }} locale={locale} />;
    case "reasoning":
      return <ReasoningCard event={event as TimelineEvent & { data: { kind: "reasoning" } }} locale={locale} />;
    case "tool_activity":
      if (data.subagent) return <SubagentCard event={event as TimelineEvent & { data: { kind: "tool_activity" } }} locale={locale} onOpenSubagent={onOpenSubagent} />;
      return <ToolActivityCard event={event as TimelineEvent & { data: { kind: "tool_activity" } }} locale={locale} />;
    case "tool_group":
      return <ToolGroupCard event={event as TimelineEvent & { data: Extract<TimelineEvent["data"], { kind: "tool_group" }> }} t={t} locale={locale} onViewDiff={onViewDiff} onOpenLocalFile={onOpenLocalFile} />;
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
);
