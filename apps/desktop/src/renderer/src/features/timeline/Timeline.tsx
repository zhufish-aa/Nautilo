import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { motion } from "framer-motion";
import { BrowserActivity } from "./BrowserActivity";
import { isBrowserTool } from "../../lib/browser-display";
import {
  AlertTriangle,
  Atom,
  ArrowDown,
  ArrowRightLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  FileCode2,
  FileText,
  FlaskConical,
  GitBranch,
  ImageIcon,
  Info,
  Pencil,
  Terminal
} from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { SessionErrorCard } from "./SessionErrorCard";
import { getBridge, requestCore } from "../../lib/bridge";
import { useSessionsStore } from "../../stores/sessions";
import { useCoreFeatures } from "../../lib/use-core-features";
import { delegationActivity } from "../../lib/delegation-activity";
import { cn, formatDateTime } from "../../lib/utils";
import type { TimelineEvent } from "../../lib/types";
import type { CapabilityReference, WorkflowMention } from "@agenthub/domain";
import { composerReferences, messageReferenceParts, referenceKey, referenceParts, ReferencePills } from "../sessions/ComposerReferences";
import { WorkflowPlanCard } from "../sessions/WorkflowPlanCard";
import { SourceControlDiffView } from "../sessions/SourceControlDiffView";
import { StatusChip, Tag } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ensureProjectRunHydrated, resolveWorkbenchApproval } from "../../lib/orchestration-runtime";
import { toolActivityKind, toolActivityLabel, toolCommand, toolFilePath, toolInputFileDiff } from "../../lib/tool-display";
import { MarkdownContent } from "./MarkdownContent";
import { DelegationCard } from "./DelegationCard";
import { CodeExecutionCard } from "./CodeExecutionCard";
import { ProcessDisclosure } from "./ProcessDisclosure";
import { ToolActivityIcon } from "./ToolActivityIcon";
import { WorkflowToolActivity, workflowTool } from "./WorkflowToolActivity";
import { ManagedApprovalCard } from "./ManagedApprovalCard";
import { reasoningPreview } from "../../lib/process-display";
import { useSmoothStreamText } from "../../lib/streaming-text";
import { useMessageEntrance, useUiReducedMotion } from "../../lib/ui-motion";
import { ConversationNavigator } from "./ConversationNavigator";
import { locationAtRow, type ConversationLocation } from "../../lib/conversation-navigation";
import { reconcileTimelineKeys, type TimelineKeySequence } from "../../lib/timeline-row-keys";
import { resolveReadingAnchor, timelinePositions } from "../../lib/timeline-position";
import { ToolFileDiffView } from "./ToolFileDiffView";
import { TimelineImage } from "./TimelineImage";
import { artifactUrlForPath, openFileWithToast, popupFileMenu, popupTextMenu } from "./media-actions";
import { openFilePreview } from "../../stores/file-preview";
import { resolveFileOpenTarget } from "../../lib/file-references";
import { fileChangeCounts } from "../../lib/changed-files";
import { diffLines } from "../../lib/line-diff";
import { useVirtualizer } from "@tanstack/react-virtual";
import "./conversation-details.css";

const FOLLOW_TAIL_THRESHOLD = 48;
const EMPTY_LOCATIONS: ConversationLocation[] = [];

/**
 * Owns the vertical viewport for a timeline. TimelineEventView below is a
 * card renderer; this component is the layer that can actually observe and
 * control the scrolling element.
 */
export interface TimelineRow {
  result?: boolean;
  estimatedHeight?: number;
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
  focusKey,
  locations = EMPTY_LOCATIONS,
  active = true,
  className
}: {
  rows: TimelineRow[];
  sessionKey: string;
  contentKey?: unknown;
  forceFollowKey?: string;
  focusKey?: string;
  locations?: ConversationLocation[];
  active?: boolean;
  className?: string;
}): JSX.Element {
  const { locale } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  // Input must beat a pin already queued for the next frame.
  const followTail = useCallback((value: boolean) => {
    followTailRef.current = value;
    setPinned(value);
  }, []);
  const lastScrollTopRef = useRef(0);
  const previousContent = useRef({ sessionKey, contentKey, rowCount: rows.length, forceFollowKey });
  const tailMotion = useRef<Animation>();
  const virtualized = rows.length > 80;
  const reduced = useUiReducedMotion();
  const [currentLocation, setCurrentLocation] = useState(0);
  const navigationLock = useRef<"anchor" | "tail">();
  const touchY = useRef<number>();
  const pendingNavigation = useRef<ConversationLocation>();

  const keySequenceRef = useRef<TimelineKeySequence>();
  const keySequence = reconcileTimelineKeys(keySequenceRef.current, rows, sessionKey);
  keySequenceRef.current = keySequence;
  const previousKeys = useRef(keySequence);
  const pendingReading = useRef<{ key: string; offset: number }>();

  const virtualizer = useVirtualizer({
    // Measuring a newly mounted row can update the virtual window during a
    // React commit. Batch that update instead of re-entering it with flushSync.
    useFlushSync: false,
    enabled: active && virtualized,
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    initialOffset: () => timelinePositions.get(sessionKey)?.top ?? 0,
    scrollPaddingStart: 12,
    // Compact steps start folded at 30px. Guessing a full message height for
    // each one makes long turns shrink under the scrollbar as rows appear.
    estimateSize: (index) => rows[index]?.estimatedHeight ?? 96,
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
    const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
    if (Math.abs(bottom - element.scrollTop) > 1) {
      element.scrollTop = bottom;
    }
    lastScrollTopRef.current = element.scrollTop;
    timelinePositions.set(sessionKey, { top: element.scrollTop, follow: true });
  }, [active, sessionKey]);

  const jumpToLocation = useCallback((location: ConversationLocation) => {
    tailMotion.current?.cancel();
    pendingReading.current = undefined;
    const viewport = scrollRef.current;
    if (!viewport) return;
    followTail(false);
    navigationLock.current = "anchor";
    setCurrentLocation(locationAtRow(locations, location.rowIndex));
    const row = viewport.querySelector<HTMLElement>(`[data-index="${location.rowIndex}"]`);
    if (row) {
      pendingNavigation.current = undefined;
      const top = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - 12;
      viewport.scrollTo({ top: Math.max(0, top), behavior: reduced || virtualized ? "auto" : "smooth" });
      timelinePositions.set(sessionKey, { top: Math.max(0, top), follow: false });
    } else if (virtualized) {
      pendingNavigation.current = location;
      virtualizer.scrollToIndex(location.rowIndex, { align: "start" });
    }
  }, [followTail, locations, reduced, sessionKey, virtualized, virtualizer]);
  const resumeFollowing = useCallback(() => {
    navigationLock.current = undefined;
    followTail(true);
    scrollToTail();
  }, [followTail, scrollToTail]);
  const returnToBottom = (): void => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    pendingNavigation.current = undefined;
    pendingReading.current = undefined;
    const top = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    if (reduced || top - viewport.scrollTop <= 1) resumeFollowing();
    else {
      navigationLock.current = "tail";
      viewport.scrollTo({ top, behavior: "smooth" });
    }
  };
  const focused = useRef<string>();
  useEffect(() => {
    if (!active || !focusKey || focused.current === `${sessionKey}:${focusKey}`) return;
    const index = focusKey === "result" ? rows.reduce((last,row,index) => row.result ? index : last, -1) : keySequence.keys.indexOf(focusKey);
    if (index < 0) return;
    focused.current = `${sessionKey}:${focusKey}`;
    jumpToLocation({ id: focusKey, rowKey: rows[index].key, rowIndex: index, title: "", preview: "", timestamp: "" });
  }, [focusKey, sessionKey, active, keySequence, jumpToLocation]);

  // The target may not have a DOM node until the virtualizer changes windows.
  // Once measured, align it exactly instead of leaving the estimate as the result.
  const visibleRows = virtualizer.getVirtualItems();
  const windowStart = visibleRows[0]?.index;
  const windowEnd = visibleRows[visibleRows.length - 1]?.index;
  const saveReadingPosition = (viewport: HTMLDivElement): void => {
    if (!active) return;
    const scrollTop = viewport.scrollTop;
    if (followTailRef.current) {
      timelinePositions.set(sessionKey, { top: scrollTop, follow: true });
      return;
    }
    let firstIndex: number | undefined;
    let locationIndex: number | undefined;
    let offset = 0;
    if (virtualized) {
      const first = virtualizer.getVirtualItemForOffset(scrollTop + 1);
      firstIndex = first?.index;
      offset = first ? Math.max(0, scrollTop - first.start) : 0;
      locationIndex = virtualizer.getVirtualItemForOffset(scrollTop + 32)?.index;
    } else {
      const top = viewport.getBoundingClientRect().top;
      const items = contentRef.current?.children;
      if (items) for (let index = 0; index < items.length; index++) {
        const rectangle = items[index].getBoundingClientRect();
        if (firstIndex === undefined && rectangle.bottom > top + 1) {
          firstIndex = index;
          offset = Math.max(0, top - rectangle.top);
        }
        if (rectangle.bottom > top + 32) { locationIndex = index; break; }
      }
    }
    timelinePositions.set(sessionKey, { top: scrollTop, follow: followTailRef.current,
      rowKey: firstIndex === undefined ? undefined : rows[firstIndex]?.key, offset });
    if (locationIndex !== undefined) setCurrentLocation(locationAtRow(locations, locationIndex));
  };
  useLayoutEffect(() => {
    const target = pendingNavigation.current;
    const viewport = scrollRef.current;
    if (!target || !viewport) return;
    const row = viewport.querySelector<HTMLElement>(`[data-index="${target.rowIndex}"]`);
    if (!row) return;
    const top = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - 12;
    pendingNavigation.current = undefined;
    viewport.scrollTop = Math.max(0, top);
    lastScrollTopRef.current = viewport.scrollTop;
    timelinePositions.set(sessionKey, { top: viewport.scrollTop, follow: false });
  }, [windowStart, windowEnd, sessionKey, virtualizer.getTotalSize()]);

  // Returning to a conversation restores the reader's position. Live updates
  // keep following only if the reader left it at the tail.
  useLayoutEffect(() => {
    if (!active) return;
    pendingNavigation.current = undefined;
    navigationLock.current = undefined;
    const saved = timelinePositions.get(sessionKey);
    followTail(saved?.follow ?? true);
    const viewport = scrollRef.current;
    if (viewport && saved && !saved.follow) {
      viewport.scrollTop = saved.top;
      lastScrollTopRef.current = viewport.scrollTop;
    } else scrollToTail();
  }, [active, followTail, scrollToTail, sessionKey]);

  // Row IDs survive streaming, history prepends and folding. Pixel offsets
  // alone cannot preserve the reader when rows before the viewport change.
  useLayoutEffect(() => {
    const previous = previousKeys.current;
    previousKeys.current = keySequence;
    if (!active || followTailRef.current || pendingNavigation.current) return;
    const saved = timelinePositions.get(sessionKey);
    const index = resolveReadingAnchor(saved?.rowKey, keySequence.keys, previous.sessionKey === sessionKey ? previous.keys : []);
    if (index < 0) return;
    pendingReading.current = { key: keySequence.keys[index], offset: saved?.rowKey === keySequence.keys[index] ? saved.offset ?? 0 : 0 };
    if (virtualized) virtualizer.scrollToIndex(index, { align: "start" });
  }, [keySequence, active, sessionKey, virtualized]);
  useLayoutEffect(() => {
    const pending = pendingReading.current;
    const viewport = scrollRef.current;
    if (!pending || !viewport || followTailRef.current) return;
    const index = keySequence.keys.indexOf(pending.key);
    const row = viewport.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!row) return;
    pendingReading.current = undefined;
    viewport.scrollTop += row.getBoundingClientRect().top - viewport.getBoundingClientRect().top + pending.offset;
    lastScrollTopRef.current = viewport.scrollTop;
    timelinePositions.set(sessionKey, { top: viewport.scrollTop, follow: false, rowKey: pending.key, offset: pending.offset });
  }, [keySequence, windowStart, windowEnd, active, sessionKey, virtualizer.getTotalSize()]);

  useLayoutEffect(() => {
    const previous = previousContent.current;
    previousContent.current = { sessionKey, contentKey, rowCount: rows.length, forceFollowKey };
    const sent = previous.sessionKey === sessionKey && forceFollowKey !== undefined && forceFollowKey !== previous.forceFollowKey;
    if (!active || !followTailRef.current || (!sent && previous.contentKey === contentKey && previous.rowCount === rows.length)) return;
    const viewport = scrollRef.current;
    if (!viewport) return;
    const top = viewport.scrollTop;
    scrollToTail();
    const distance = Math.min(viewport.scrollTop - top, 48);
    if (!sent || reduced || distance <= 1) return;
    tailMotion.current?.cancel();
    tailMotion.current = contentRef.current?.animate?.([
      { transform: `translateY(${distance}px)` },
      { transform: "translateY(0)" }
    ], { duration: 220, easing: "cubic-bezier(.22, 1, .36, 1)" });
  }, [active, contentKey, forceFollowKey, reduced, rows.length, scrollToTail, sessionKey]);
  useLayoutEffect(() => () => tailMotion.current?.cancel(), [active, reduced, sessionKey]);

  // Child streams/Markdown workers can commit after the parent's event effect.
  // Observe actual content and viewport sizes, then pin once on the next frame.
  // Never write scroll/layout synchronously inside ResizeObserver: that used
  // to feed back into virtual row measurement and create observer loops.
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!active || !viewport || !content) return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (!followTailRef.current || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        scrollToTail();
      });
    });
    observer.observe(content);
    observer.observe(viewport);
    const finishReturn = () => { if (navigationLock.current === "tail") resumeFollowing(); };
    viewport.addEventListener("scrollend", finishReturn);
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scrollend", finishReturn);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [active, resumeFollowing, scrollToTail, sessionKey]);

  // Virtual row measurements also update the spacer's explicit height.
  const totalSize = virtualizer.getTotalSize();
  const previousTotalSizeRef = useRef(totalSize);
  useLayoutEffect(() => {
    if (totalSize === previousTotalSizeRef.current) return;
    previousTotalSizeRef.current = totalSize;
    scrollToTail();
  }, [totalSize, scrollToTail]);

  const interruptNavigation = (viewport: HTMLDivElement): void => {
    tailMotion.current?.cancel();
    if (navigationLock.current) viewport.scrollTop = viewport.scrollTop;
    navigationLock.current = undefined;
    pendingNavigation.current = undefined;
    pendingReading.current = undefined;
  };

  return (
    <div className="relative h-full min-h-0">
    {active && <ConversationNavigator sessionKey={sessionKey} locations={locations} current={pinned ? Math.max(0, locations.length - 1) : currentLocation} onNavigate={jumpToLocation} />}
    <div
      ref={scrollRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        if (event.target !== element) return;
        const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
        if (element.scrollTop < lastScrollTopRef.current - 1 && gap > FOLLOW_TAIL_THRESHOLD) {
          // Collapsing process rows or enlarging the viewport clamps scrollTop
          // to a smaller bottom offset. That is not the user scrolling up.
          followTail(false);
        } else if (navigationLock.current !== "anchor" && gap <= FOLLOW_TAIL_THRESHOLD && element.scrollTop > lastScrollTopRef.current) {
          // Only scrolling DOWN into the tail re-engages follow mode.
          resumeFollowing();
        }
        lastScrollTopRef.current = element.scrollTop;
        saveReadingPosition(element);
      }}
      onWheel={(event) => {
        if (!event.deltaY) return;
        interruptNavigation(event.currentTarget);
        if (event.deltaY < 0 && event.currentTarget.scrollTop > 0) {
          followTail(false);
          saveReadingPosition(event.currentTarget);
        }
      }}
      onPointerDown={(event) => interruptNavigation(event.currentTarget)}
      onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY; }}
      onTouchMove={(event) => {
        const y = event.touches[0]?.clientY;
        if (y !== undefined && touchY.current !== undefined && y > touchY.current && event.currentTarget.scrollTop > 0) {
          interruptNavigation(event.currentTarget);
          followTail(false);
          saveReadingPosition(event.currentTarget);
        }
        touchY.current = y;
      }}
      onClickCapture={(event) => {
        const trigger = event.target instanceof Element && event.target.closest("button.process-disclosure-trigger, button.conversation-process-toggle");
        if (!trigger || !event.currentTarget.contains(trigger)) return;
        // Reading a past detail is a manual navigation. Do not follow its expanding height back to the tail.
        navigationLock.current = "anchor";
        followTail(false);
        pendingReading.current = undefined;
        pendingNavigation.current = undefined;
        saveReadingPosition(event.currentTarget);
      }}
      style={{ overflowAnchor: "none", willChange: "scroll-position" }}
      className={cn("relative h-full overflow-y-auto", className)}
      aria-live="polite"
    >
      <div className="overflow-clip">
        <div ref={contentRef} data-timeline-content="" style={{ height: virtualized ? totalSize : undefined, position: "relative", width: "100%" }}>
          {(virtualized ? virtualizer.getVirtualItems() : rows.map((row, index) => ({ key: row.key, index, start: 0 }))).map((virtualRow) => (
            <div
              key={virtualRow.key}
              ref={virtualized ? virtualizer.measureElement : undefined}
              data-index={virtualRow.index}
              style={{
                position: virtualized ? "absolute" : "relative",
                top: 0,
                left: 0,
                width: "100%",
                transform: virtualized ? `translateY(${virtualRow.start}px)` : undefined
              }}
            >
              {rows[virtualRow.index]?.render()}
            </div>
          ))}
        </div>
      </div>
    </div>
    {active && !pinned && <button type="button" className="timeline-return-to-bottom" onClick={returnToBottom}>
      <ArrowDown size={14} aria-hidden />{locale === "zh-CN" ? "回到底部" : "Back to bottom"}
    </button>}
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

function MessageCard({ event, locale, onEditMessage, onOpenLocalFile, showAuthor = true, streamActive, revealFromStart }: {
  event: TimelineEvent & { data: Extract<TimelineEvent["data"], { kind: "message" }> };
  locale: "zh-CN" | "en-US";
  onEditMessage?: (messageId: string, text: string, workflowRef?: WorkflowMention, references?: CapabilityReference[]) => void;
  onOpenLocalFile?: (path: string) => void;
  showAuthor?: boolean;
  streamActive: boolean;
  revealFromStart: boolean;
}): JSX.Element {
  const { sender, authorName, text, streaming, messageId, attachments, editedAt, workflowRef, references } = event.data;
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const isUser = sender === "user";
  const isSystem = sender === "system";
  const entranceRef = useMessageEntrance(event.sessionId, isUser ? messageId : undefined);
  const reduced = useUiReducedMotion();
  const visible = useSmoothStreamText(text, Boolean(streaming), streamActive && !reduced, revealFromStart);
  const renderingLive = streamActive && (Boolean(streaming) || visible.text !== text);
  const items = useMemo(() => isUser ? composerReferences(references, workflowRef) : [], [isUser, references, workflowRef]);
  const inlineKeys = useMemo(() => new Set(referenceParts(text, items).flatMap(part => part.item ? [referenceKey(part.item)] : [])), [text, items]);
  const renderInline = useCallback((part: string) => messageReferenceParts(part, items), [items]);
  if (isSystem) {
    return (
      <motion.p
        initial={false}
        animate={{ opacity: 1 }}
        className="log-line py-1 text-center text-ink-3"
      >
        — {text} · {formatDateTime(event.timestamp, locale)} —
      </motion.p>
    );
  }
  return (
      <div
      className="group flex w-full"
    >
      <div className={cn("min-w-0 flex-1", isUser && "flex flex-col items-end")}>
        {isUser ? <span className="sr-only">{locale === "zh-CN" ? "你" : "You"}</span> : showAuthor && <div className="assistant-identity"><span className="assistant-mark"><Bot size={16} aria-hidden /></span><strong>{authorName ?? "Nautilo"}</strong></div>}
        <div
          ref={entranceRef}
          className={cn(
            "text-[15px] leading-7 text-ink",
            isUser && "chat-bubble-user max-w-[88%] rounded-2xl bg-card-hover px-4 py-3"
          )}
          onContextMenu={(event) => {
            event.preventDefault();
            void popupTextMenu(window.getSelection()?.toString() ?? "", t);
          }}
        >
          {items.length > 0 && <ReferencePills items={items.filter(item => !inlineKeys.has(referenceKey(item)))} />}
          <MarkdownContent source={visible.text} inverted={false} onOpenLocalFile={onOpenLocalFile} streaming={renderingLive} fade={visible.fade}
            renderInlineText={inlineKeys.size ? renderInline : undefined} />
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
                  {attachment.unavailable && <span className="shrink-0 text-xs text-ink-3">{locale === "zh-CN" ? "请在原生会话中查看" : "View in native session"}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        {!streaming && (
          <div className="conversation-message-actions ms-auto flex w-fit items-center gap-1 rounded-lg bg-card opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100" title={formatDateTime(event.timestamp, locale)}>
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
                onClick={() => onEditMessage(messageId, text, workflowRef, references)}
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
    </div>
  );
}

function ActivityLine({ event, locale }: { event: TimelineEvent & { data: { kind: "activity" } }; locale: "zh-CN" | "en-US" }): JSX.Element | null {
  if (event.data.phase === "stopped") return <p className="py-1 text-[13px] text-ink-3">{locale === "zh-CN" ? "已停止" : "Stopped"}</p>;
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

function ReasoningCard({ event, locale, streamActive, revealFromStart }: {
  event: TimelineEvent & { data: { kind: "reasoning" } }; locale: "zh-CN" | "en-US"; streamActive: boolean; revealFromStart: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const streaming = Boolean(event.data.streaming);
  const reduced = useUiReducedMotion();
  const visible = useSmoothStreamText(event.data.text, streaming, streamActive && !reduced, revealFromStart);
  const preview = useMemo(() => reasoningPreview(visible.text), [visible.text]);
  return <ProcessDisclosure className="reasoning-card" icon={<Atom size={14} />} label={locale === "zh-CN" ? "思考" : "Thinking"}
    preview={preview} followPreviewTail open={open} onToggle={() => setOpen(value => !value)} running={streaming}>
    <MarkdownContent source={visible.text} streaming={streamActive && (streaming || visible.text !== event.data.text)} fade={visible.fade} />
  </ProcessDisclosure>;
}

function ToolActivityCard({ event, locale, t, onOpenLocalFile }: {
  event: TimelineEvent & { data: { kind: "tool_activity" } };
  locale: "zh-CN" | "en-US";
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
  onOpenLocalFile?: (path: string, diff?: string) => void;
}): JSX.Element {
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
  const kind = toolActivityKind(toolName, input);
  const path = ["read", "write", "edit", "skill"].includes(kind) ? resolvedFileDiff?.path ?? toolFilePath(input) : undefined;
  const command = kind === "command" ? toolCommand(input) : undefined;
  const { executor, summary } = command ? commandPresentation(command) : {};
  const label = command ? (status === "failed" ? (zh ? "命令执行失败" : "Command failed") : (zh ? "运行" : "Run"))
    : toolActivityLabel(toolName, status, input, locale, Boolean(path));
  if (isBrowserTool(toolName)) return <BrowserActivity name={toolName} status={status} input={input} output={output} zh={zh}/>;
  const accessory = counts && <span className="flex gap-1.5 tabular-nums"><span className="text-ok">+{counts.additions}</span><span className="text-danger">−{counts.deletions}</span></span>;
  return (
    <ProcessDisclosure className="tool-activity-card" label={label} accessory={accessory} badge={executor} monospace={Boolean(command)}
      preview={path ? <button type="button" className="file-activity-name" onClick={() => openTimelineFile(path, t, onOpenLocalFile, "drawer")}>
        {path.split(/[\\/]/).at(-1) || path}
      </button> : summary}
      previewTitle={path ?? command} retainPreview
      icon={status === "failed" ? <AlertTriangle size={14} /> : <ToolActivityIcon name={toolName} input={input} />}
      open={open} onToggle={details ? () => setOpen(value => !value) : undefined} running={status === "running"} failed={status === "failed"}>
      <div className="overflow-hidden rounded-xl border border-line bg-card">
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
    </ProcessDisclosure>
  );
}

function ProviderCompatibilityNotice({ text, zh }: { text: string; zh: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  return <ProcessDisclosure className="provider-compatibility-note" icon={<Info size={14} />}
    label={zh ? "扩展兼容性提示 · billion-context-pi" : "Extension compatibility · billion-context-pi"}
    open={open} onToggle={() => setOpen(value => !value)}>
    <div className="command-disclosure-output"><pre>{text}</pre></div>
  </ProcessDisclosure>;
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
  const { subagent } = event.data;
  const status = event.data.status === "failed" ? "failed" : subagent?.status ?? event.data.status;
  const tone = status === "running" ? "accent" : status === "done" ? "ok" : "danger";
  const statusLabel = status === "running"
    ? subagent?.background ? t("sessions.cards.subagentBackgroundRunning") : t("sessions.cards.running")
    : status === "done"
      ? t("sessions.status.completed")
      : t("sessions.cards.failed");
  const activityCount = subagent?.activities?.length ?? 0;
  const activities = subagent?.activities ?? [];
  const latest = [...activities].reverse().find(data => delegationActivity(data, locale === "zh-CN"));
  const result = status === "done" ? [...activities].reverse().find(data => data.kind === "message" && data.sender === "agent" && !data.streaming) : undefined;
  return (
    <DelegationCard
      name={subagent?.agentType || t("sessions.cards.subagent")}
      task={subagent?.task}
      status={statusLabel}
      tone={tone}
      running={status === "running"}
      native
      activity={delegationActivity(latest, locale === "zh-CN")}
      result={delegationActivity(result, locale === "zh-CN")}
      zh={locale === "zh-CN"}
      meta={[subagent?.model, subagent?.background ? t("sessions.cards.subagentBackground") : undefined].filter((value): value is string => Boolean(value))}
      actionLabel={activityCount > 0 ? t("sessions.cards.subagentDetailCount", { count: activityCount }) : t("sessions.cards.subagentDetail")}
      onOpen={onOpenSubagent ? () => onOpenSubagent(event.id) : undefined}
      input={event.data.input}
      output={event.data.output}
      toolName={event.data.toolName}
      time={formatDateTime(event.timestamp, locale)}
    />
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
  const features = useCoreFeatures();
  const child = useSessionsStore(state => state.sessions.find(session => session.id === event.data.sessionId || session.taskId === event.data.taskId));
  const owner = useSessionsStore(state => state.sessions.find(session => session.id === event.sessionId));
  const latest = useSessionsStore(state => {
    const items = child ? state.events[child.id] : undefined;
    return items && [...items].reverse().find(item => delegationActivity(item.data, locale === "zh-CN"));
  });
  const result = useSessionsStore(state => child && event.data.status === "completed" ? [...(state.events[child.id] ?? [])].reverse().find(item => item.data.kind === "message" && item.data.sender === "agent" && !item.data.streaming) : undefined);
  const statusTone: Record<string, "muted" | "info" | "accent" | "ok" | "danger" | "warn"> = {
    draft: "muted",
    ready: "muted",
    queued: "muted",
    running: "accent",
    completed: "ok",
    failed: "danger",
    cancelled: "muted",
    blocked_dependency: "warn",
    verifying: "info",
    waiting_user: "warn",
    waiting_approval: "warn",
    review_required: "warn",
    merge_ready: "info"
  };
  return (
    <DelegationCard
      name={event.data.memberName || (locale === "zh-CN" ? "委派任务" : "Delegated task")}
      task={event.data.title}
      status={t(`sessions.taskStatus.${event.data.status}` as MessageKey)}
      tone={statusTone[event.data.status] ?? "muted"}
      running={event.data.status === "running" || event.data.status === "verifying"}
      cancelled={event.data.status === "cancelled"}
      zh={locale === "zh-CN"}
      onOpen={child && onOpenSession ? () => onOpenSession(child.id) : undefined}
      actionLabel={event.data.status === "completed" ? (locale === "zh-CN" ? "查看结果" : "View result") : undefined}
      activity={delegationActivity(latest?.data, locale === "zh-CN")}
      result={delegationActivity(result?.data, locale === "zh-CN")}
      onRetry={features.taskRetry && owner?.projectRunId && ["failed", "cancelled"].includes(event.data.status) ? async () => {
        const projectRunId = owner?.projectRunId;
        if (!projectRunId) return;
        await requestCore("orchestration.retryTask", { projectRunId, taskId: event.data.taskId });
        await ensureProjectRunHydrated(projectRunId);
      } : undefined}
      input={event.data.dispatchCall?.input}
      output={event.data.dispatchCall?.output}
      toolName={event.data.dispatchCall?.toolName}
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    />
  );
}

function commandPresentation(command: string): { executor?: string; summary: string } {
  const singleLine = command.replace(/\s+/g, " ").trim();
  const prefix = singleLine.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const executor = (prefix?.[1] ?? prefix?.[2] ?? prefix?.[3])?.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "");
  const argumentsText = singleLine.slice(prefix?.[0].length ?? 0).trim();
  const summary = /^(?:powershell|pwsh)$/i.test(executor ?? "")
    ? argumentsText.match(/(?:^|\s)-(?:Command|c)\s+(.+)$/i)?.[1]?.replace(/^"|"$/g, "") ?? argumentsText
    : argumentsText;
  return { executor, summary };
}

function CommandCard({ event, t, locale }: { event: TimelineEvent & { data: { kind: "command" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { command, status, exitCode, output, attempts = 1 } = event.data;
  const { executor, summary } = commandPresentation(command);
  const zh = locale === "zh-CN";
  return <ProcessDisclosure className="command-card" icon={status === "failed" ? <AlertTriangle size={14} /> : <Terminal size={14} />}
    label={status === "failed" ? (zh ? "命令执行失败" : "Command failed") : zh ? "运行" : status === "running" ? "Running" : "Ran"}
    badge={executor} preview={summary} previewTitle={command} monospace retainPreview
    open={open} onToggle={() => setOpen(value => !value)} running={status === "running"} failed={status === "failed"}
    accessory={status === "running" || attempts > 1 ? <>{status === "running" && <span className="sr-only">{t("sessions.cards.running")}</span>}{attempts > 1 && (zh ? `${attempts} 次` : `${attempts} attempts`)}</> : undefined}>
    <div className="command-disclosure-output">
      <pre><code>{command}</code></pre>
      {output && <pre>{output}</pre>}
      {exitCode !== undefined && <p className="command-disclosure-exit" data-failed={exitCode !== 0 || undefined}>{t("sessions.cards.exitCode", { code: exitCode })}</p>}
    </div>
  </ProcessDisclosure>;
}

function FileChangeCard({ event, locale, t, onOpenLocalFile }: {
  event: TimelineEvent & { data: { kind: "file_change" } };
  locale: "zh-CN" | "en-US";
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
  onOpenLocalFile?: (path: string, diff?: string) => void;
}): JSX.Element {
  const [openPath, setOpenPath] = useState<string>();
  const zh = locale === "zh-CN";
  return <div>{event.data.files.map(file => {
    const expanded = file.path === openPath;
    const counts = file.comparisonUnavailable ? undefined : fileChangeCounts(file);
    const label = file.changeType === "added" ? (zh ? "已写入" : "Wrote")
      : file.changeType === "deleted" ? (zh ? "已删除" : "Deleted") : (zh ? "已编辑" : "Edited");
    const preview = file.path.split(/[\\/]/).at(-1) || file.path;
    const openFile = (): void => {
      if (onOpenLocalFile && file.diff && !file.comparisonUnavailable) onOpenLocalFile(file.path, file.diff);
      else openTimelineFile(file.path, t, onOpenLocalFile, "drawer");
    };
    const canOpen = file.changeType !== "deleted" || (!!file.diff && !!onOpenLocalFile);
    return <ProcessDisclosure key={file.path} className="file-activity" label={label}
      preview={canOpen ? <button type="button" className="file-activity-name" onClick={openFile}>{preview}</button> : preview}
      previewTitle={file.path} retainPreview icon={file.changeType === "added" ? <FileCode2 size={14} /> : <Pencil size={14} />}
      accessory={counts && <span className="flex gap-1.5 tabular-nums"><span className="text-ok">+{counts.additions}</span><span className="text-danger">−{counts.deletions}</span></span>}
      open={expanded} onToggle={() => setOpenPath(expanded ? undefined : file.path)}>
      <div className="conversation-inline-diff">
        {file.diff && !file.comparisonUnavailable
          ? <SourceControlDiffView patch={file.diff} scope={`${event.id}:${file.path}`} locale={locale} />
          : <p>{zh ? "这条记录没有可显示的差异。" : "No diff is available for this record."}</p>}
        {canOpen && <button type="button" className="mt-2 text-xs text-ink-3 hover:text-ink" onClick={openFile}>
          {file.diff && !file.comparisonUnavailable && onOpenLocalFile ? zh ? "在预览中查看改动" : "View changes in preview" : zh ? "预览文件" : "Preview file"}
        </button>}
      </div>
    </ProcessDisclosure>;
  })}</div>;
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
            <Circle className="h-2 w-2 shrink-0 fill-current text-info" aria-label={t("sessions.cards.running")} />
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

function ApprovalCard({ event }: { event: TimelineEvent & { data: { kind: "approval" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string }): JSX.Element {
  return <ManagedApprovalCard approval={event.data.approval} onResolve={(approved, scope) => resolveWorkbenchApproval(event.sessionId, event.data.approval.id, approved, scope)} />;
}

function ErrorCard({ event, locale }: { event: TimelineEvent & { data: { kind: "error" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string }): JSX.Element {
  return <SessionErrorCard event={event} locale={locale}/>;
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
  onOpenSession,
  onEditMessage,
  onOpenSubagent,
  onOpenLocalFile,
  onOpenWorkflow,
  showAuthor = true,
  streamActive = false,
  liveStarts
}: {
  event: TimelineEvent;
  onOpenSession?: (id: string) => void;
  onEditMessage?: (messageId: string, text: string, workflowRef?: WorkflowMention, references?: CapabilityReference[]) => void;
  onOpenSubagent?: (eventId: string) => void;
  onOpenWorkflow?: (runId: string) => void;
  /** Work mode only: local file clicks route to the session's preview pane. */
  onOpenLocalFile?: (path: string) => void;
  showAuthor?: boolean;
  streamActive?: boolean;
  liveStarts?: ReadonlySet<string>;
}): JSX.Element | null {
  const { t, locale } = useI18n();
  const data = event.data;

  switch (data.kind) {
    case "message":
      return <MessageCard event={event as TimelineEvent & { data: Extract<TimelineEvent["data"], { kind: "message" }> }} locale={locale} onEditMessage={onEditMessage} onOpenLocalFile={onOpenLocalFile} showAuthor={showAuthor} streamActive={streamActive} revealFromStart={liveStarts?.has(event.id) ?? false} />;
    case "workflow_plan":
      return <WorkflowPlanCard key={data.plan.id} plan={data.plan} runStatus={data.runStatus} onViewExecution={onOpenWorkflow}/>;
    case "provider_ui":
      if (data.method === "open_url" && data.url) return <a href={data.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 py-1 text-[13px] text-accent underline underline-offset-4" onClick={(event) => { const bridge = getBridge(); if (bridge) { event.preventDefault(); void bridge.shell.openExternal(data.url!).catch(() => {}); } }}>{data.text || (locale === "zh-CN" ? "打开授权链接" : "Open authorization link")} ↗</a>;
      if (data.method !== "notify" || !data.text.trim()) return null;
      if (data.text.startsWith("[billion-context-pi] Unsupported host:")) return <ProviderCompatibilityNotice text={data.text} zh={locale === "zh-CN"} />;
      return <p className="whitespace-pre-wrap py-1 text-[13px] text-ink-2">{data.text}</p>;
    case "activity":
      return <ActivityLine event={event as TimelineEvent & { data: { kind: "activity" } }} locale={locale} />;
    case "reasoning":
      return <ReasoningCard event={event as TimelineEvent & { data: { kind: "reasoning" } }} locale={locale} streamActive={streamActive} revealFromStart={liveStarts?.has(event.id) ?? false} />;
    case "tool_activity": {
      if (data.subagent) return <SubagentCard event={event as TimelineEvent & { data: { kind: "tool_activity" } }} locale={locale} onOpenSubagent={onOpenSubagent} />;
      const action = workflowTool(data.toolName);
      if (action) return <WorkflowToolActivity action={action} name={data.toolName} sessionId={event.sessionId} runId={event.runId}
        input={data.input} output={data.output} status={data.status} zh={locale === "zh-CN"} />;
      if (data.toolName === "run_code" || data.codeExecution) return <CodeExecutionCard data={data} locale={locale} sessionId={event.sessionId} runId={event.runId} />;
      return <ToolActivityCard event={event as TimelineEvent & { data: { kind: "tool_activity" } }} locale={locale} t={t} onOpenLocalFile={onOpenLocalFile} />;
    }
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
      return <FileChangeCard event={event as TimelineEvent & { data: { kind: "file_change" } }} locale={locale} t={t} onOpenLocalFile={onOpenLocalFile} />;
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
    && prev.onOpenSession === next.onOpenSession
    && prev.onEditMessage === next.onEditMessage
    && prev.onOpenSubagent === next.onOpenSubagent
    && prev.onOpenWorkflow === next.onOpenWorkflow
    && prev.onOpenLocalFile === next.onOpenLocalFile
    && prev.showAuthor === next.showAuthor
    && prev.streamActive === next.streamActive
    && prev.liveStarts === next.liveStarts
);
