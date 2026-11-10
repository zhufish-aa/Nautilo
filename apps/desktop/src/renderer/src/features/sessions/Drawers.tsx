import { useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { Bot, FileText, Loader2, SquareTerminal, TerminalSquare } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { collectChangedFiles, type ChangedFileEntry } from "../../lib/changed-files";
import { patchFileImages, reverseApplyUnifiedPatch, revertFileDiffs, sameContent } from "../../lib/revert-change";
import { formatDurationMs, parseSubagentInput, parseSubagentResult, type SubagentUsage } from "../../lib/subagent-result";
import { highlightDiffLine } from "../../lib/highlight";
import { terminalWindowStart } from "../../lib/terminal-window";
import { useProgressiveRows } from "../../lib/use-progressive-rows";
import { cn } from "../../lib/utils";
import type { SessionTask, TimelineEvent } from "../../lib/types";
import { WorkspaceDrawer as Drawer } from "./WorkspaceDrawer";
import { ChangeReview, type ReviewEditorState } from "./ChangeReview";
import { buildReviewFiles, reviewBefore, type ReviewChangeGroup } from "../../lib/change-review";
import { Button } from "../../components/ui/Button";
import { StatusChip, Tag } from "../../components/ui/Badge";
import { MarkdownContent } from "../timeline/MarkdownContent";
import { TimelineEventView } from "../timeline/Timeline";
import { sessionTargetName } from "./SessionListPanel";
import { useAgentsStore } from "../../stores/agents";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore, SESSION_EMPTY } from "../../stores/sessions";
import { useTeamsStore } from "../../stores/teams";
import { NativeTerminal } from "./NativeTerminal";
import { requestCore } from "../../lib/bridge";
import type { NativeRuntimeCapabilities } from "@agenthub/provider-sdk";
import { useNativeTerminalStatus } from "../../lib/use-native-terminal";
import { toast } from "../../stores/toast";

const MultiTerminalDrawer = lazy(() => import("./TerminalWorkspace").then(module => ({ default: module.TerminalDrawer })));

/* ---------------------------------------------------------------------------
 * Terminal workspace: native CLI, shell and runtime logs share one toolbar.
 * ------------------------------------------------------------------------ */
export function TerminalDrawer({
  open,
  onClose,
  sessionId
}: {
  open: boolean;
  onClose: () => void;
  sessionId?: string;
}): JSX.Element {
  const [multiTabs, setMultiTabs] = useState<boolean>();
  const { locale } = useI18n();
  useEffect(() => {
    if (!open || !sessionId || multiTabs !== undefined) return;
    let disposed = false;
    // A live older daemon may still own the user's terminal. Upgrade the
    // workspace after the next daemon start without interrupting that PTY.
    void requestCore("terminal.list", { sessionId }).then(() => { if (!disposed) setMultiTabs(true); }).catch(() => { if (!disposed) setMultiTabs(false); });
    return () => { disposed = true; };
  }, [open, sessionId, multiTabs]);
  if (multiTabs) return <Suspense fallback={null}><MultiTerminalDrawer open={open} onClose={onClose} sessionId={sessionId} /></Suspense>;
  if (multiTabs === false || !sessionId) return <LegacyTerminalDrawer open={open} onClose={onClose} sessionId={sessionId} />;
  return open ? <Drawer placement="bottom" open onClose={onClose} title={locale === "zh-CN" ? "终端" : "Terminal"} resizable><div className="terminal-workspace-loading" role="status"><Loader2 size={16} className="animate-spin" />{locale === "zh-CN" ? "正在恢复终端" : "Restoring terminals"}</div></Drawer> : <></>;
}

function LegacyTerminalDrawer({ open, onClose, sessionId }: { open: boolean; onClose: () => void; sessionId?: string }): JSX.Element {
  const { t, locale } = useI18n();
  const lines = useSessionsStore((state) => (sessionId ? (state.rawLog[sessionId] ?? SESSION_EMPTY.lines) : SESSION_EMPTY.lines));
  const bottomRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const [lineLimit, setLineLimit] = useState(500);
  const [view, setView] = useState<"terminal" | "native" | "logs">("terminal");
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null);
  const nativeActive = useNativeTerminalStatus(sessionId, open);
  useEffect(() => { if (open && nativeActive) setView("native"); }, [open, sessionId, nativeActive]);
  useEffect(() => {
    if (!open || !sessionId) return;
    let disposed = false;
    void requestCore<NativeRuntimeCapabilities>("agent.runtimeCapabilities", { sessionId }).then((capabilities) => { if (!disposed) setNativeAvailable(capabilities.interactions.nativeTerminal); }).catch(() => { if (!disposed) setNativeAvailable(false); });
    return () => { disposed = true; };
  }, [open, sessionId]);
  useEffect(() => { setLineLimit(500); followOutput.current = true; }, [sessionId]);

  useEffect(() => {
    if (open && followOutput.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length, open]);

  if (!open) return <></>;
  const startLine = terminalWindowStart(lines.length, lineLimit);
  return (
    <Drawer placement="bottom" open={open} onClose={onClose} title={locale === "zh-CN" ? "终端" : "Terminal"} resizable defaultHeight={320} storageKey="nautilo.terminal.height"
      headerContent={<div className="terminal-tabs" role="tablist" aria-label={locale === "zh-CN" ? "终端视图" : "Terminal views"}>
        <button type="button" className="terminal-tab" role="tab" aria-selected={view === "terminal"} onClick={() => setView("terminal")}><SquareTerminal size={14} aria-hidden />{locale === "zh-CN" ? "终端" : "Terminal"}</button>
        {nativeAvailable && <button type="button" className="terminal-tab" role="tab" aria-selected={view === "native"} onClick={() => setView("native")}><TerminalSquare size={14} aria-hidden />{locale === "zh-CN" ? "原生 CLI" : "Native CLI"}</button>}
        <button type="button" className="terminal-tab" role="tab" aria-selected={view === "logs"} onClick={() => setView("logs")}><FileText size={14} aria-hidden />{locale === "zh-CN" ? "运行日志" : "Logs"}</button>
      </div>}
      headerActions={<div ref={setToolbarTarget} className="workspace-panel-actions" />}>
      {view !== "logs" && sessionId ? <NativeTerminal key={`${sessionId}:${view}`} sessionId={sessionId} kind={view === "native" ? "harness" : "shell"} toolbarTarget={toolbarTarget} /> : <div className="h-full overflow-y-auto bg-canvas px-5 py-4" onScroll={(event) => { const node = event.currentTarget; followOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; }}>
        {startLine > 0 && <button type="button" className="mb-3 rounded px-2 py-1 text-xs text-ink-3 hover:bg-card-hover" onClick={() => setLineLimit((limit) => limit + 500)}>{t("sessions.interactions.showMore")} ({startLine})</button>}
        {lines.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-ink-3">
            <TerminalSquare className="h-6 w-6" aria-hidden />
            <p className="text-xs">{t("sessions.drawers.terminalEmpty")}</p>
          </div>
        ) : (
          <pre className="font-mono text-[13px] leading-6 whitespace-pre-wrap">
            {lines.slice(startLine).map((line, index) => (
              <div key={startLine + index} className={line.startsWith("$ ") ? "mt-2 text-ink" : "text-ink-2"}>
                {line}
              </div>
            ))}
            <div ref={bottomRef} />
          </pre>
        )}
      </div>}
    </Drawer>
  );
}

/* ---------------------------------------------------------------------------
 * F-035: diff / artifacts drawer.
 * ------------------------------------------------------------------------ */
function DiffView({ content }: { content: string }): JSX.Element {
  const { locale } = useI18n();
  const lines = useMemo(() => content.split("\n"), [content]);
  // Progressive mount, same as ToolFileDiffView: each row runs a highlight.js
  // pass, so a large patch must not render all at once.
  const { limit, sentinelRef, showAll } = useProgressiveRows(lines.length, lines);
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <pre className="min-w-full font-mono text-xs leading-relaxed">
        {lines.slice(0, limit).map((line, index) => (
          <div
            key={index}
            className={cn(
              "hljs px-4 whitespace-pre-wrap break-all",
              line.startsWith("+") && !line.startsWith("+++")
                ? "bg-ok/10 text-ok"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "bg-danger/10 text-danger"
                  : line.startsWith("@@")
                    ? "bg-info/10 text-info"
                    : "text-ink-2"
            )}
            dangerouslySetInnerHTML={{ __html: highlightDiffLine(line) }}
          />
        ))}
        {limit < lines.length && (
          <button
            ref={sentinelRef}
            type="button"
            onClick={showAll}
            className="my-1 w-full rounded-md py-1 text-center font-sans text-[11px] text-ink-3 transition-colors hover:bg-card-hover hover:text-ink"
          >
            {locale === "zh-CN"
              ? `加载剩余 ${lines.length - limit} 行…（点击全部展开）`
              : `Loading ${lines.length - limit} more rows… (click to expand all)`}
          </button>
        )}
      </pre>
    </div>
  );
}

const CLOSED_DRAWER_ITEMS: never[] = [];
const EMPTY_EVENT_MAP: ReturnType<typeof useSessionsStore.getState>["events"] = {};
const EMPTY_ARTIFACT_MAP: ReturnType<typeof useSessionsStore.getState>["artifacts"] = {};

export function ArtifactsDrawer({
  open,
  onClose,
  sessionId,
  focusPath
}: {
  open: boolean;
  onClose: () => void;
  sessionId?: string;
  /** When set, selects this file in the diff list upon opening. */
  focusPath?: string | null;
}): JSX.Element {
  const { t, locale } = useI18n();
  const artifacts = useSessionsStore((state) => (open && sessionId ? (state.artifacts[sessionId] ?? SESSION_EMPTY.artifacts) : SESSION_EMPTY.artifacts));
  const events = useSessionsStore((state) => (open && sessionId ? (state.events[sessionId] ?? SESSION_EMPTY.events) : SESSION_EMPTY.events));
  const sessions = useSessionsStore((state) => open ? state.sessions : CLOSED_DRAWER_ITEMS);
  const allEvents = useSessionsStore((state) => open ? state.events : EMPTY_EVENT_MAP);
  const allArtifacts = useSessionsStore((state) => open ? state.artifacts : EMPTY_ARTIFACT_MAP);
  const teams = useTeamsStore((state) => open ? state.teams : CLOSED_DRAWER_ITEMS);
  const instances = useAgentsStore((state) => open ? state.instances : CLOSED_DRAWER_ITEMS);
  const projects = useProjectsStore((state) => open ? state.projects : CLOSED_DRAWER_ITEMS);
  const session = sessions.find((item) => item.id === sessionId);
  const projectRoot = projects.find((item) => item.id === session?.projectId)?.rootPath;

  // Diff sources: this session's timeline plus every delegated sub-session's
  // timeline. kimi sessions surface edits via tool fileDiff, codex via
  // file_change events — collectChangedFiles covers both.
  const changeGroups = useMemo(() => {
    if (!open) return [];
    const groups: ReviewChangeGroup[] = [
      { id: sessionId ?? "main", entries: collectChangedFiles(events) }
    ];
    for (const sub of sessions.filter((item) => item.parentSessionId === sessionId)) {
      const entries = collectChangedFiles(allEvents[sub.id] ?? []);
      if (entries.length > 0) groups.push({ id: sub.id, label: sessionTargetName(sub, teams, instances), entries });
    }
    return groups;
  }, [open, events, sessions, sessionId, allEvents, teams, instances]);

  const reviewFiles = useMemo(() => buildReviewFiles(changeGroups, projectRoot), [changeGroups, projectRoot]);
  const [selectedId, setSelectedId] = useState<string>();
  const selectedFile = Math.max(0, reviewFiles.findIndex(file => file.id === selectedId));
  const [editor, setEditor] = useState<ReviewEditorState | null>(null);
  const editRequest = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [editLoading, setEditLoading] = useState(false);
  // Per-change revert: two-click confirm (撤回 → 确认撤回), then the recorded
  // change is reverse-applied to the live file (exact match; fails safely).
  const [revertArmed, setRevertArmed] = useState(false);
  const [reverting, setReverting] = useState(false);
  useEffect(() => {
    editRequest.current += 1;
    setEditor(null);
    setEditLoading(false);
    setRevertArmed(false);
  }, [reviewFiles[selectedFile]?.id, open, sessionId]);

  const revertChange = async (entry: ChangedFileEntry): Promise<void> => {
    const bridge = window.agenthub;
    if (!bridge) return;
    if (entry.kind === "patch" && entry.comparisonUnavailable) {
      toast.error(t("sessions.drawers.noDiffDetail"));
      return;
    }
    const basePaths = projectRoot ? [projectRoot] : [];
    setReverting(true);
    try {
      if (entry.kind === "fileDiff") {
        if (entry.diffs.some((diff) => diff.truncated)) {
          toast.error(t("sessions.drawers.revertTruncated"));
          return;
        }
        const read = await bridge.files.readText({ path: entry.path, basePaths });
        if (read.ok && read.truncated) {
          toast.error(t("sessions.drawers.revertTruncated"));
          return;
        }
        if (!read.ok) {
          toast.error(t("sessions.drawers.revertFailed"));
          return;
        }
        const result = revertFileDiffs(read.content, entry.diffs);
        if (!result.ok) {
          toast.error(t("sessions.drawers.revertFailed"));
          return;
        }
        // The agent created the file (all fragments started from nothing) and
        // the revert empties it → move it to trash instead of leaving a husk.
        const createdByAgent = entry.diffs.every((diff) => !diff.before);
        if (createdByAgent && result.content.trim() === "") {
          const deleted = await bridge.files.delete({ path: read.resolvedPath });
          if (!deleted.ok) {
            toast.error(deleted.message ?? t("sessions.drawers.revertFailed"));
            return;
          }
          toast.success(t("sessions.drawers.revertDeleted"));
          return;
        }
        const write = await bridge.files.writeText({ path: read.resolvedPath, content: result.content });
        if (!write.ok) {
          toast.error(write.message ?? t("sessions.drawers.revertFailed"));
          return;
        }
        toast.success(t("sessions.drawers.revertDone"));
        return;
      }

      // Unified-patch entries (codex file_change events).
      if (!entry.diff) return;
      if (entry.changeType === "added") {
        const read = await bridge.files.readText({ path: entry.path, basePaths });
        if (read.ok && read.truncated) {
          toast.error(t("sessions.drawers.revertTruncated"));
          return;
        }
        if (!read.ok || !sameContent(read.content, patchFileImages(entry.diff).after)) {
          toast.error(t("sessions.drawers.revertFailed"));
          return;
        }
        const deleted = await bridge.files.delete({ path: read.resolvedPath });
        if (!deleted.ok) {
          toast.error(deleted.message ?? t("sessions.drawers.revertFailed"));
          return;
        }
        toast.success(t("sessions.drawers.revertDeleted"));
        return;
      }
      if (entry.changeType === "deleted") {
        // The bridge has no atomic create-if-absent operation. A stale deletion
        // patch must never overwrite a file recreated by the user or another run.
        toast.error(locale === "zh-CN"
          ? "请手动恢复已删除文件，避免覆盖后来创建的内容。"
          : "Restore deleted files manually to avoid overwriting newer content.");
        return;
      }
      const read = await bridge.files.readText({ path: entry.path, basePaths });
      if (read.ok && read.truncated) {
        toast.error(t("sessions.drawers.revertTruncated"));
        return;
      }
      if (!read.ok) {
        toast.error(t("sessions.drawers.revertFailed"));
        return;
      }
      const result = reverseApplyUnifiedPatch(read.content, entry.diff);
      if (!result.ok) {
        toast.error(t("sessions.drawers.revertFailed"));
        return;
      }
      const write = await bridge.files.writeText({ path: read.resolvedPath, content: result.content });
      if (!write.ok) {
        toast.error(write.message ?? t("sessions.drawers.revertFailed"));
        return;
      }
      toast.success(t("sessions.drawers.revertDone"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("sessions.drawers.revertFailed"));
    } finally {
      setReverting(false);
      setRevertArmed(false);
      setRefreshVersion(version => version + 1);
    }
  };

  const startEdit = async (entry: ChangedFileEntry): Promise<void> => {
    const bridge = window.agenthub;
    if (!bridge) return;
    const request = ++editRequest.current;
    setEditLoading(true);
    try {
      const result = await bridge.files.readText({ path: entry.path, basePaths: projectRoot ? [projectRoot] : [] });
      if (request !== editRequest.current) return;
      if (!result.ok) {
        toast.error(t("sessions.drawers.editReadFailed"));
        return;
      }
      if (result.truncated) {
        toast.error(t("sessions.drawers.editTooLarge"));
        return;
      }
      const before = reviewBefore(entry, result.content);
      setEditor({ path: entry.path, resolvedPath: result.resolvedPath, original: result.content, value: result.content, saving: false, before });
    } catch {
      if (request === editRequest.current) toast.error(t("sessions.drawers.editReadFailed"));
    } finally {
      if (request === editRequest.current) setEditLoading(false);
    }
  };

  const saveEdit = async (): Promise<void> => {
    const bridge = window.agenthub;
    if (!bridge || !editor) return;
    // Textareas normalize line breaks to LF; restore the file's original CRLF.
    const content = editor.original.includes("\r\n") ? editor.value.replace(/\r?\n/g, "\r\n") : editor.value;
    setEditor({ ...editor, saving: true });
    try {
      const current = await bridge.files.readText({ path: editor.resolvedPath, basePaths: projectRoot ? [projectRoot] : [] });
      if (!current.ok || current.truncated || !sameContent(current.content, editor.original)) {
        toast.error(locale === "zh-CN" ? "文件已在外部更改，请重新打开后再编辑。" : "The file changed outside this editor. Reopen it before saving.");
        setEditor(value => value ? { ...value, saving: false } : value);
        return;
      }
      const result = await bridge.files.writeText({ path: editor.resolvedPath, content });
      if (result.ok) {
        toast.success(t("sessions.drawers.editSaved"));
        setEditor(null);
        setRefreshVersion(version => version + 1);
      } else {
        toast.error(result.message ?? t("sessions.drawers.editFailed"));
        setEditor({ ...editor, saving: false });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("sessions.drawers.editFailed"));
      setEditor({ ...editor, saving: false });
    }
  };

  // A focus request is consumed once. New stream events must not pull selection back.
  const focusedRequest = useRef("");
  useEffect(() => { setSelectedId(undefined); focusedRequest.current = ""; }, [sessionId]);
  useEffect(() => {
    if (!open) { focusedRequest.current = ""; return; }
    if (!focusPath) return;
    const request = JSON.stringify([sessionId, focusPath]);
    if (focusedRequest.current === request) return;
    const file = reviewFiles.find(item => item.entry.path.replace(/\\/g, "/") === focusPath.replace(/\\/g, "/"));
    if (file) { setSelectedId(file.id); focusedRequest.current = request; }
  }, [open, focusPath, sessionId, reviewFiles]);

  if (!open) return <></>;

  const comparisonArtifacts = [
    ...artifacts,
    ...sessions.filter((item) => item.parentSessionId === sessionId)
      .flatMap((item) => allArtifacts[item.id] ?? [])
  ].filter((artifact) => artifact.kind === "diff" && artifact.content);
  const filesystemComparisons = comparisonArtifacts.filter((artifact) => artifact.diffSource === "filesystem");
  const providerComparisons = comparisonArtifacts.filter((artifact) => artifact.diffSource === "provider");
  const comparisonUnavailable = artifacts.some((artifact) => artifact.comparisonUnavailable)
    || sessions.some((item) => item.parentSessionId === sessionId
      && allArtifacts[item.id]?.some((artifact) => artifact.comparisonUnavailable));

  const reviewArtifacts = [
    ...artifacts,
    ...sessions.filter(item => item.parentSessionId === sessionId).flatMap(item => allArtifacts[item.id] ?? [])
  ];

  return (
    <Drawer open={open} onClose={onClose} title={locale === "zh-CN" ? "文件更改" : "File changes"} defaultWidth={1200} defaultMaximized hideHeader className="change-review-drawer">
      <ChangeReview key={sessionId ?? "current"} groups={changeGroups} projectRoot={projectRoot} sessionId={sessionId}
        selectedIndex={selectedFile} onSelect={index => setSelectedId(reviewFiles[index]?.id)} onClose={onClose}
        editor={editor} onEditorChange={value => setEditor(current => current ? { ...current, value } : current)}
        onEdit={entry => void startEdit(entry)} onCancelEdit={() => setEditor(null)} onSaveEdit={() => void saveEdit()}
        onRevert={entry => { if (!revertArmed) setRevertArmed(true); else void revertChange(entry); }}
        editLoading={editLoading} revertArmed={revertArmed} reverting={reverting} refreshVersion={refreshVersion}
        artifacts={reviewArtifacts} sourceCount={filesystemComparisons.length + providerComparisons.length}
        comparisonUnavailable={comparisonUnavailable}
        sourceContent={<>
          {filesystemComparisons.length > 0 && <ComparisonSourcePanel artifacts={filesystemComparisons} locale={locale} />}
          {providerComparisons.length > 0 && <ComparisonSourcePanel artifacts={providerComparisons} locale={locale} source="provider" />}
        </>}

      />
    </Drawer>
  );
}

/* ---------------------------------------------------------------------------
 * F-034: task DAG drawer — only rendered when a plan created tasks.
 * ------------------------------------------------------------------------ */
function layoutDag(tasks: SessionTask[]): { x: number; y: number }[] {
  const levels: number[] = tasks.map(() => 0);
  const indexOf = new Map(tasks.map((task, index) => [task.id, index]));
  let changed = true;
  let guard = 0;
  while (changed && guard < 16) {
    changed = false;
    guard += 1;
    tasks.forEach((task, index) => {
      const level = task.dependencies.length
        ? Math.max(...task.dependencies.map((dep) => (levels[indexOf.get(dep) ?? -1] ?? -1) + 1))
        : 0;
      if (level !== levels[index]) {
        levels[index] = level;
        changed = true;
      }
    });
  }
  const perLevel = new Map<number, number>();
  return tasks.map((_, index) => {
    const level = levels[index];
    const row = perLevel.get(level) ?? 0;
    perLevel.set(level, row + 1);
    return { x: 40 + level * 220, y: 40 + row * 96 };
  });
}

export function DagDrawer({
  open,
  onClose,
  tasks
}: {
  open: boolean;
  onClose: () => void;
  tasks: SessionTask[];
}): JSX.Element {
  const { t } = useI18n();
  const positions = useMemo(() => layoutDag(tasks), [tasks]);
  const indexOf = useMemo(() => new Map(tasks.map((task, index) => [task.id, index])), [tasks]);
  const maxX = Math.max(0, ...positions.map((pos) => pos.x)) + 220;
  const maxY = Math.max(0, ...positions.map((pos) => pos.y)) + 110;

  const statusTone: Record<string, string> = {
    queued: "text-ink-3 border-line",
    running: "text-accent border-accent/50",
    completed: "text-ok border-ok/50",
    failed: "text-danger border-danger/50",
    blocked_dependency: "text-warn border-warn/50"
  };

  if (!open) return <></>;
  return (
    <Drawer open={open} onClose={onClose} title={t("sessions.drawers.dag")} subtitle={t("sessions.drawers.dagNote")} defaultWidth={560}>
      <div className="h-full overflow-auto p-4">
        <svg width={maxX} height={maxY} role="img" aria-label={t("sessions.drawers.dag")}>
          <defs>
            <marker id="dag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ink-3)" />
            </marker>
          </defs>
          {tasks.flatMap((task, index) =>
            task.dependencies.map((dep) => {
              const from = positions[indexOf.get(dep) ?? -1];
              const to = positions[index];
              if (!from || !to) return null;
              const x1 = from.x + 180;
              const y1 = from.y + 30;
              const x2 = to.x;
              const y2 = to.y + 30;
              const midX = (x1 + x2) / 2;
              return (
                <path
                  key={`${dep}-${task.id}`}
                  d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="var(--line-strong)"
                  strokeWidth="1.5"
                  markerEnd="url(#dag-arrow)"
                />
              );
            })
          )}
          {tasks.map((task, index) => {
            const pos = positions[index];
            const title = task.title.length > 12 ? `${task.title.slice(0, 12)}…` : task.title;
            const subtitle = `${task.memberName ?? "—"} · ${t(`sessions.taskStatus.${task.status}` as MessageKey)}`;
            return (
              <g key={task.id} transform={`translate(${pos.x}, ${pos.y})`}>
                <rect width="180" height="60" rx="7" fill="var(--card)" stroke="var(--line-strong)" strokeWidth="1" />
                <text x="16" y="24" fill="var(--ink)" fontSize="12" fontWeight="600">
                  {title}
                </text>
                <text x="16" y="44" fill="var(--ink-3)" fontSize="11">
                  {subtitle.length > 18 ? `${subtitle.slice(0, 18)}…` : subtitle}
                </text>
              </g>
            );
          })}
        </svg>
        <ul className="mt-4 space-y-1 border-t border-line px-1 pt-3">
          {tasks.map((task) => (
            <li key={task.id} className="flex min-w-0 items-center gap-2 text-xs">
              <span
                aria-hidden
                className={cn("h-1.5 w-1.5 shrink-0 rounded-full", (statusTone[task.status] ?? statusTone.queued).split(" ")[0])}
                style={{ background: "currentColor" }}
              />
              <span className="min-w-0 flex-1 truncate text-ink-2" title={task.title}>
                {task.title}
              </span>
              <span className="max-w-[45%] shrink-0 truncate text-ink-3">
                {task.memberName ?? "—"} · {t(`sessions.taskStatus.${task.status}` as MessageKey)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Drawer>
  );
}

/* ---------------------------------------------------------------------------
 * Provider-native sub-agent detail: the dispatch card's nested activity.
 * ------------------------------------------------------------------------ */
function SubagentUsageChips({ usage, agentId }: { usage?: SubagentUsage; agentId?: string }): JSX.Element | null {
  const { t, locale } = useI18n();
  if (!usage && !agentId) return null;
  const chip = "rounded-md border border-line bg-card px-1.5 py-0.5 font-mono text-[10px] text-ink-3";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {usage?.totalTokens !== undefined && (
        <span className={chip}>{t("sessions.drawers.subagentUsageTokens", { count: usage.totalTokens.toLocaleString(locale) })}</span>
      )}
      {usage?.toolUses !== undefined && <span className={chip}>{t("sessions.drawers.subagentUsageTools", { count: usage.toolUses })}</span>}
      {usage?.durationMs !== undefined && <span className={chip}>{formatDurationMs(usage.durationMs)}</span>}
      {agentId && <span className={chip} title={agentId}>agentId: {agentId.length > 12 ? `${agentId.slice(0, 6)}…${agentId.slice(-4)}` : agentId}</span>}
    </div>
  );
}

export function SubagentDrawer({
  open,
  onClose,
  sessionId,
  eventId
}: {
  open: boolean;
  onClose: () => void;
  sessionId?: string;
  eventId?: string;
}): JSX.Element {
  const { t } = useI18n();
  const event = useSessionsStore((state) =>
    (sessionId ? state.events[sessionId] ?? [] : []).find((item) => item.id === eventId));
  const data = event?.data.kind === "tool_activity" ? event.data : undefined;
  const subagent = data?.subagent;
  const status = data?.status === "failed" ? "failed" : subagent?.status ?? data?.status;
  const tone = status === "running" ? "accent" : status === "done" ? "ok" : "danger";
  const statusLabel = status === "running"
    ? subagent?.background ? t("sessions.cards.subagentBackgroundRunning") : t("sessions.cards.running")
    : status === "done"
      ? t("sessions.status.completed")
      : t("sessions.cards.failed");
  const activities: TimelineEvent[] = (subagent?.activities ?? []).map((payload, index) => ({
    id: `${eventId ?? "sub"}-activity-${index}`,
    sessionId: sessionId ?? "",
    sequence: index + 1,
    timestamp: event?.timestamp ?? "",
    data: payload
  }));
  const inputView = useMemo(() => (data?.input ? parseSubagentInput(data.input) : undefined), [data?.input]);
  const resultView = useMemo(() => (data?.output ? parseSubagentResult(data.output) : undefined), [data?.output]);

  if (!open) return <></>;
  return (
    <Drawer open={open} onClose={onClose} title={t("sessions.drawers.subagent")} subtitle={subagent?.task} defaultWidth={560}>
      <div className="h-full overflow-y-auto p-4">
        <div className="mb-3 flex items-center gap-2">
          <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center text-ink-3">
            <Bot className="h-4 w-4" />
          </span>
          {subagent?.agentType && <Tag label={subagent.agentType} />}
          {subagent?.model && <Tag label={subagent.model} />}
          {subagent?.nativeAgentIds?.map((id) => <span key={id} title={id} className="font-mono text-xs">{id.slice(0, 8)}</span>)}
          {subagent?.background && <Tag label={t("sessions.cards.subagentBackground")} />}
          {data && <StatusChip tone={tone} label={statusLabel} pulse={status === "running"} className="h-5 px-1.5 text-[10px]" />}
          <SubagentUsageChips usage={resultView?.usage} agentId={resultView?.agentId} />
        </div>
        {subagent?.task && (
          <p className="mb-4 px-1 py-2.5 text-[13px] leading-relaxed break-all whitespace-pre-wrap text-ink-2">
            {subagent.task}
          </p>
        )}
        {activities.length === 0 ? (
          <div className="rounded-xl border border-line px-3 py-4 text-center">
            <p className="text-xs text-ink-3">{t("sessions.drawers.subagentEmpty")}</p>
            {data?.status !== "running" && (
              <p className="mt-1 text-[11px] leading-relaxed text-ink-3/70">{t("sessions.drawers.subagentEmptyHint")}</p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {activities.map((activity) => (
              <TimelineEventView key={activity.id} event={activity} />
            ))}
          </div>
        )}
        {(inputView || resultView) && (
          <div className="mt-4 space-y-2 border-t border-line pt-3">
            {resultView && (
              <details className="overflow-hidden rounded-xl border border-line bg-card" open={activities.length === 0}>
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-3">
                  {t("sessions.drawers.subagentResult")}
                </summary>
                <div className="max-h-96 overflow-auto border-t border-line px-3.5 py-2.5 text-[13px] text-ink-2">
                  <MarkdownContent source={resultView.body} />
                </div>
              </details>
            )}
            {inputView?.prompt && (
              <details className="overflow-hidden rounded-xl border border-line bg-card" open={activities.length === 0}>
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-3">
                  {t("sessions.drawers.subagentPrompt")}
                </summary>
                <p className="max-h-56 overflow-auto border-t border-line px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-2">
                  {inputView.prompt}
                </p>
              </details>
            )}
            {inputView && (inputView.raw !== undefined || inputView.fields.length > 0) && (
              <details className="overflow-hidden rounded-xl border border-line bg-card">
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-3">
                  {t("sessions.drawers.subagentInputRaw")}
                </summary>
                {inputView.raw !== undefined ? (
                  <pre className="max-h-56 overflow-auto border-t border-line px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">{inputView.raw}</pre>
                ) : (
                  <dl className="space-y-1.5 border-t border-line px-3.5 py-2.5">
                    {inputView.fields.map(([key, value]) => (
                      <div key={key} className="flex min-w-0 gap-2 text-[12px]">
                        <dt className="shrink-0 font-mono text-ink-3">{key}</dt>
                        <dd className="min-w-0 flex-1 break-all whitespace-pre-wrap text-ink-2">{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </details>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}

/** Mount potentially large comparison text only when explicitly opened. */
function ComparisonSourcePanel({ artifacts, locale, source = "filesystem" }: {
  artifacts: { id: string; name: string; content: string }[];
  locale: string;
  source?: "filesystem" | "provider";
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts.at(-1);
  return (
    <section className="shrink-0 border-b border-line">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between px-5 py-3 text-left text-sm text-ink-2 hover:bg-card-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
        <span>{source === "provider"
          ? (locale === "zh-CN" ? "Agent 差异原文" : "Agent diff source")
          : (locale === "zh-CN" ? "文件系统对比（采集范围内）" : "Filesystem comparison (captured scope)")}</span>
        <span aria-hidden="true">{expanded ? "−" : "+"}</span>
      </button>
      {expanded && selected && (
        <div className="border-t border-line">
          {artifacts.length > 1 && (
            <select aria-label={locale === "zh-CN" ? "选择对比记录" : "Choose comparison record"}
              value={selected.id} onChange={(event) => setSelectedId(event.target.value)}
              className="m-3 max-w-[calc(100%-1.5rem)] rounded-md border border-line bg-card px-2 py-1 text-sm text-ink">
              {artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.name}</option>)}
            </select>
          )}
          <div className="h-64 overflow-hidden"><DiffView content={selected.content} /></div>
        </div>
      )}
    </section>
  );
}
