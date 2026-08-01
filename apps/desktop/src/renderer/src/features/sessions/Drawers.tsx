import { useEffect, useMemo, useRef, useState, Fragment, lazy, Suspense } from "react";
import { Bot, Loader2, Pencil, RotateCcw, TerminalSquare } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { collectChangedFiles, type ChangedFileEntry } from "../../lib/changed-files";
import { patchFileImages, reverseApplyUnifiedPatch, revertFileDiffs, sameContent } from "../../lib/revert-change";
import { formatDurationMs, parseSubagentInput, parseSubagentResult, type SubagentUsage } from "../../lib/subagent-result";
import { highlightDiffLine } from "../../lib/highlight";
import { useProgressiveRows } from "../../lib/use-progressive-rows";
import { cn } from "../../lib/utils";
import type { SessionTask, TimelineEvent } from "../../lib/types";
import { Drawer } from "../../components/ui/Drawer";
import { TabBar } from "../../components/ui/Tabs";
import { Button } from "../../components/ui/Button";
import { StatusChip, Tag } from "../../components/ui/Badge";
import { ToolFileDiffView } from "../timeline/ToolFileDiffView";
import { MarkdownContent } from "../timeline/MarkdownContent";
import { TimelineEventView } from "../timeline/Timeline";
import { sessionTargetName } from "./SessionListPanel";
import { useAgentsStore } from "../../stores/agents";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useTeamsStore } from "../../stores/teams";
import { toast } from "../../stores/toast";

// Monaco is heavy; it only loads when the user actually opens the file editor.
const DiffCodeEditor = lazy(() => import("../../components/ui/DiffCodeEditor"));

/* ---------------------------------------------------------------------------
 * F-033: raw terminal drawer — debug fallback only, never replaces chat.
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
  const { t } = useI18n();
  const lines = useSessionsStore((state) => (sessionId ? (state.rawLog[sessionId] ?? []) : []));
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length, open]);

  return (
    <Drawer open={open} onClose={onClose} title={t("sessions.drawers.terminal")} subtitle={t("sessions.drawers.terminalNote")}>
      <div className="h-full overflow-y-auto bg-[#0a0c12] px-4 py-3">
        {lines.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-ink-3">
            <TerminalSquare className="h-6 w-6" aria-hidden />
            <p className="text-xs">{t("sessions.drawers.terminalEmpty")}</p>
          </div>
        ) : (
          <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {lines.map((line, index) => (
              <div key={index} className={line.startsWith("$ ") ? "mt-2 text-accent" : "text-[#a8e6a3]/90"}>
                {line}
              </div>
            ))}
            <div ref={bottomRef} />
          </pre>
        )}
      </div>
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
  const artifacts = useSessionsStore((state) => (sessionId ? (state.artifacts[sessionId] ?? []) : []));
  const events = useSessionsStore((state) => (sessionId ? (state.events[sessionId] ?? []) : []));
  const sessions = useSessionsStore((state) => state.sessions);
  const allEvents = useSessionsStore((state) => state.events);
  const teams = useTeamsStore((state) => state.teams);
  const instances = useAgentsStore((state) => state.instances);
  const projects = useProjectsStore((state) => state.projects);
  const session = sessions.find((item) => item.id === sessionId);
  const projectRoot = projects.find((item) => item.id === session?.projectId)?.rootPath;

  // Diff sources: this session's timeline plus every delegated sub-session's
  // timeline. kimi sessions surface edits via tool fileDiff, codex via
  // file_change events — collectChangedFiles covers both.
  const changeGroups = useMemo(() => {
    const groups: { label?: string; entries: ChangedFileEntry[] }[] = [
      { entries: collectChangedFiles(events) }
    ];
    for (const sub of sessions.filter((item) => item.parentSessionId === sessionId)) {
      const entries = collectChangedFiles(allEvents[sub.id] ?? []);
      if (entries.length > 0) groups.push({ label: sessionTargetName(sub, teams, instances), entries });
    }
    return groups;
  }, [events, sessions, sessionId, allEvents, teams, instances]);

  const changedFiles = useMemo(() => changeGroups.flatMap((group) => group.entries), [changeGroups]);

  const tabs = [
    { value: "diff", label: t("sessions.drawers.tabs.diff") },
    { value: "api_contract", label: t("sessions.drawers.tabs.contract") },
    { value: "test_report", label: t("sessions.drawers.tabs.test") },
    { value: "commit", label: t("sessions.drawers.tabs.commit") }
  ];
  const [tab, setTab] = useState("diff");
  const [selectedFile, setSelectedFile] = useState(0);

  // In-diff file editor, VS Code-style (monaco diff editor): left shows the
  // reconstructed pre-change file (read-only), right the live file (editable).
  // `before` is undefined when the pre-change content can no longer be
  // reconstructed exactly; a plain editor is shown in that case.
  const [editor, setEditor] = useState<{
    path: string;
    resolvedPath: string;
    original: string;
    value: string;
    saving: boolean;
    before?: string;
  } | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  // Per-change revert: two-click confirm (撤回 → 确认撤回), then the recorded
  // change is reverse-applied to the live file (exact match; fails safely).
  const [revertArmed, setRevertArmed] = useState(false);
  const [reverting, setReverting] = useState(false);
  useEffect(() => {
    setEditor(null);
    setRevertArmed(false);
  }, [selectedFile, open]);

  const revertChange = async (entry: ChangedFileEntry): Promise<void> => {
    const bridge = window.agenthub;
    if (!bridge) return;
    const basePaths = projectRoot ? [projectRoot] : [];
    setReverting(true);
    try {
      if (entry.kind === "fileDiff") {
        if (entry.diffs.some((diff) => diff.truncated)) {
          toast.error(t("sessions.drawers.revertTruncated"));
          return;
        }
        const read = await bridge.files.readText({ path: entry.path, basePaths });
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
        // The file is gone, so resolve the path without readText and restore it.
        const absolute = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(entry.path)
          ? entry.path
          : projectRoot
            ? `${projectRoot.replace(/[\\/]+$/, "")}/${entry.path}`
            : "";
        if (!absolute) {
          toast.error(t("sessions.drawers.revertFailed"));
          return;
        }
        const write = await bridge.files.writeText({ path: absolute, content: patchFileImages(entry.diff).before });
        if (!write.ok) {
          toast.error(write.message ?? t("sessions.drawers.revertFailed"));
          return;
        }
        toast.success(t("sessions.drawers.revertDone"));
        return;
      }
      const read = await bridge.files.readText({ path: entry.path, basePaths });
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
    }
  };

  const startEdit = async (entry: ChangedFileEntry): Promise<void> => {
    const bridge = window.agenthub;
    if (!bridge) return;
    setEditLoading(true);
    try {
      const result = await bridge.files.readText({ path: entry.path, basePaths: projectRoot ? [projectRoot] : [] });
      if (!result.ok) {
        toast.error(t("sessions.drawers.editReadFailed"));
        return;
      }
      if (result.truncated) {
        toast.error(t("sessions.drawers.editTooLarge"));
        return;
      }
      // Reconstruct the pre-change content for the diff editor's left side.
      const before = ((): string | undefined => {
        if (entry.kind === "fileDiff") {
          if (entry.diffs.some((diff) => diff.truncated)) return undefined;
          const reverted = revertFileDiffs(result.content, entry.diffs);
          return reverted.ok ? reverted.content : undefined;
        }
        if (!entry.diff) return undefined;
        if (entry.changeType === "added") return "";
        const reverted = reverseApplyUnifiedPatch(result.content, entry.diff);
        return reverted.ok ? reverted.content : undefined;
      })();
      setEditor({ path: entry.path, resolvedPath: result.resolvedPath, original: result.content, value: result.content, saving: false, before });
    } catch {
      toast.error(t("sessions.drawers.editReadFailed"));
    } finally {
      setEditLoading(false);
    }
  };

  const saveEdit = async (): Promise<void> => {
    const bridge = window.agenthub;
    if (!bridge || !editor) return;
    // Textareas normalize line breaks to LF; restore the file's original CRLF.
    const content = editor.original.includes("\r\n") ? editor.value.replace(/\r?\n/g, "\r\n") : editor.value;
    setEditor({ ...editor, saving: true });
    try {
      const result = await bridge.files.writeText({ path: editor.resolvedPath, content });
      if (result.ok) {
        toast.success(t("sessions.drawers.editSaved"));
        setEditor(null);
      } else {
        toast.error(result.message ?? t("sessions.drawers.editFailed"));
        setEditor({ ...editor, saving: false });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("sessions.drawers.editFailed"));
      setEditor({ ...editor, saving: false });
    }
  };

  // Opening via a "view diff" entry jumps straight to the referenced file;
  // timeline refreshes keep the user's selection whenever it is still valid.
  useEffect(() => {
    if (!open) return;
    setTab("diff");
    setSelectedFile((current) => {
      const index = focusPath ? changedFiles.findIndex((file) => file.path === focusPath) : -1;
      if (index >= 0) return index;
      return current < changedFiles.length ? current : 0;
    });
  }, [open, focusPath, changedFiles]);

  const filtered = artifacts.filter((artifact) => artifact.kind === tab);

  return (
    <Drawer open={open} onClose={onClose} title={t("sessions.drawers.artifacts")} defaultWidth={1200}>
      <div className="flex h-full flex-col">
        <div className="border-b border-line px-5 py-3">
          <TabBar aria-label={t("sessions.drawers.artifacts")} value={tab} onValueChange={setTab} items={tabs} />
        </div>

        {tab === "diff" ? (
          changedFiles.length === 0 ? (
            <p className="flex-1 px-5 py-10 text-center text-sm text-ink-3">{t("sessions.drawers.noChanges")}</p>
          ) : (
            <div className="flex min-h-0 flex-1">
              <ul className="w-56 shrink-0 space-y-1 overflow-y-auto border-r border-line p-3">
                {(() => {
                  let flatIndex = -1;
                  return changeGroups.map((group, groupIndex) => (
                    <Fragment key={group.label ?? "main"}>
                      {group.label && (
                        <li className={cn("px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3", groupIndex > 0 && "pt-2")}>
                          {group.label}
                        </li>
                      )}
                      {group.entries.map((entry) => {
                        flatIndex += 1;
                        const index = flatIndex;
                        const stats = entry.kind === "patch"
                          ? { added: entry.additions, removed: entry.deletions }
                          : {
                              added: entry.diff.after ? entry.diff.after.split(/\r?\n/).length : 0,
                              removed: entry.diff.before ? entry.diff.before.split(/\r?\n/).length : 0
                            };
                        return (
                          <li key={`${entry.path}-${index}`}>
                            <button
                              onClick={() => setSelectedFile(index)}
                              aria-current={selectedFile === index}
                              className={cn(
                                "w-full truncate rounded-lg px-2.5 py-2 text-left font-mono text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                                selectedFile === index ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-card-hover"
                              )}
                              title={entry.path}
                            >
                              {entry.path.split(/[\\/]/).pop()}
                              {entry.edits > 1 && <span className="ml-1 text-[10px] text-ink-3">×{entry.edits}</span>}
                              <span className="ml-1.5 font-mono text-[10px]">
                                <span className="text-ok">+{stats.added}</span>{" "}
                                <span className="text-danger">-{stats.removed}</span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </Fragment>
                  ));
                })()}
              </ul>
              <div className="flex min-w-0 flex-1 flex-col">
                {(() => {
                  const selected = changedFiles[selectedFile];
                  if (!selected) {
                    return <p className="px-5 py-10 text-sm text-ink-3">{t("sessions.drawers.noChanges")}</p>;
                  }
                  const diffContent = selected.kind === "patch" ? (
                    selected.diff ? (
                      <DiffView content={selected.diff} />
                    ) : (
                      <p className="px-5 py-10 text-sm text-ink-3">{t("sessions.drawers.noDiffDetail")}</p>
                    )
                  ) : (
                    <div className="h-full overflow-y-auto">
                      <ToolFileDiffView diff={selected.diff} locale={locale} scrollClassName="max-h-none" />
                    </div>
                  );
                  if (editor) {
                    const dirty = editor.value !== editor.original.replace(/\r\n/g, "\n");
                    return (
                      <>
                        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3" title={editor.resolvedPath}>
                            {editor.resolvedPath}
                          </span>
                          <Button variant="ghost" size="sm" disabled={editor.saving} onClick={() => setEditor(null)}>
                            {t("common.cancel")}
                          </Button>
                          <Button variant="primary" size="sm" disabled={editor.saving || !dirty} onClick={() => void saveEdit()}>
                            {editor.saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                            {t("common.save")}
                          </Button>
                        </div>
                        {/* VS Code-style monaco diff editor: reconstructed
                            pre-change file (read-only) | live file (editable). */}
                        <div className="flex min-h-0 flex-1 flex-col">
                          {editor.before === undefined ? (
                            <p className="shrink-0 border-b border-line px-3 py-1 text-[11px] text-warn">
                              {t("sessions.drawers.beforeUnavailable")}
                            </p>
                          ) : (
                            <div className="flex shrink-0 border-b border-line text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                              <span className="flex-1 border-r border-line px-3 py-1">{t("sessions.drawers.beforeLabel")}</span>
                              <span className="flex-1 px-3 py-1">{t("sessions.drawers.afterLabel")}</span>
                            </div>
                          )}
                          <Suspense
                            fallback={
                              <div className="flex flex-1 items-center justify-center gap-2 text-sm text-ink-3">
                                <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
                                {t("sessions.filePreview.loading")}
                              </div>
                            }
                          >
                            <DiffCodeEditor
                              key={`${editor.resolvedPath}|${editor.before === undefined ? "single" : "diff"}`}
                              before={editor.before}
                              value={editor.value}
                              onChange={(next) => setEditor((current) => (current ? { ...current, value: next } : current))}
                              filePath={editor.resolvedPath}
                            />
                          </Suspense>
                        </div>
                      </>
                    );
                  }
                  return (
                    <>
                      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3" title={selected.path}>
                          {selected.path}
                        </span>
                        <button
                          type="button"
                          disabled={reverting}
                          onClick={() => {
                            if (!revertArmed) {
                              setRevertArmed(true);
                              return;
                            }
                            void revertChange(selected);
                          }}
                          className={cn(
                            "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors disabled:opacity-50",
                            revertArmed ? "bg-warn/10 text-warn" : "text-ink-3 hover:bg-card-hover hover:text-ink"
                          )}
                        >
                          {reverting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
                          {revertArmed ? t("sessions.drawers.revertConfirm") : t("sessions.drawers.revert")}
                        </button>
                        <button
                          type="button"
                          disabled={editLoading}
                          onClick={() => void startEdit(selected)}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-ink-3 transition-colors hover:bg-card-hover hover:text-ink disabled:opacity-50"
                        >
                          {editLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Pencil className="h-3.5 w-3.5" aria-hidden />}
                          {t("sessions.drawers.edit")}
                        </button>
                      </div>
                      <div className="min-h-0 flex-1">{diffContent}</div>
                    </>
                  );
                })()}
              </div>
            </div>
          )
        ) : filtered.length === 0 ? (
          <p className="flex-1 px-5 py-10 text-center text-sm text-ink-3">{t("sessions.drawers.noArtifacts")}</p>
        ) : (
          <div className="flex-1 space-y-3 overflow-y-auto p-5">
            {filtered.map((artifact) => (
              <section key={artifact.id} className="overflow-hidden rounded-xl border border-line">
                <header className="border-b border-line bg-card-hover px-4 py-2.5 text-[13px] font-medium text-ink-2">
                  {artifact.name}
                </header>
                <pre className="overflow-x-auto bg-card px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2">
                  {artifact.content}
                </pre>
              </section>
            ))}
          </div>
        )}
      </div>
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
            const tone = statusTone[task.status] ?? statusTone.queued;
            const title = task.title.length > 12 ? `${task.title.slice(0, 12)}…` : task.title;
            const subtitle = `${task.memberName ?? "—"} · ${t(`sessions.taskStatus.${task.status}` as MessageKey)}`;
            return (
              <g key={task.id} transform={`translate(${pos.x}, ${pos.y})`}>
                <rect width="180" height="60" rx="12" fill="var(--card)" stroke="var(--line-strong)" strokeWidth="1" />
                <rect width="4" height="60" rx="2" fill="currentColor" className={tone.split(" ")[0]} />
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
  const tone = data?.status === "running" ? "accent" : data?.status === "done" ? "ok" : "danger";
  const statusLabel = data?.status === "running"
    ? subagent?.background ? t("sessions.cards.subagentBackgroundRunning") : t("sessions.cards.running")
    : data?.status === "done"
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

  return (
    <Drawer open={open} onClose={onClose} title={t("sessions.drawers.subagent")} subtitle={subagent?.task} defaultWidth={560}>
      <div className="h-full overflow-y-auto p-4">
        <div className="mb-3 flex items-center gap-2">
          <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-info/20 bg-info/10 text-info">
            <Bot className="h-4 w-4" />
          </span>
          {subagent?.agentType && <Tag label={subagent.agentType} />}
          {subagent?.background && <Tag label={t("sessions.cards.subagentBackground")} />}
          {data && <StatusChip tone={tone} label={statusLabel} pulse={data.status === "running"} className="h-5 px-1.5 text-[10px]" />}
          <SubagentUsageChips usage={resultView?.usage} agentId={resultView?.agentId} />
        </div>
        {subagent?.task && (
          <p className="mb-4 rounded-xl border border-line bg-card px-3.5 py-2.5 text-[13px] leading-relaxed break-all whitespace-pre-wrap text-ink-2">
            {subagent.task}
          </p>
        )}
        {activities.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line-strong px-3 py-4 text-center">
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
                <summary className="cursor-pointer bg-card-hover px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                  {t("sessions.drawers.subagentResult")}
                </summary>
                <div className="max-h-96 overflow-auto border-t border-line px-3.5 py-2.5 text-[13px] text-ink-2">
                  <MarkdownContent source={resultView.body} />
                </div>
              </details>
            )}
            {inputView?.prompt && (
              <details className="overflow-hidden rounded-xl border border-line bg-card" open={activities.length === 0}>
                <summary className="cursor-pointer bg-card-hover px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                  {t("sessions.drawers.subagentPrompt")}
                </summary>
                <p className="max-h-56 overflow-auto border-t border-line px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-2">
                  {inputView.prompt}
                </p>
              </details>
            )}
            {inputView && (inputView.raw !== undefined || inputView.fields.length > 0) && (
              <details className="overflow-hidden rounded-xl border border-line bg-card">
                <summary className="cursor-pointer bg-card-hover px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
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
