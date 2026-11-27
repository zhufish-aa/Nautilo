import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  FileCode2,
  Folder,
  History,
  List,
  Loader2,
  MoreHorizontal,
  PanelRight,
  Pencil,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { FileTypeIcon } from "../../components/ui/FileTypeIcon";
import {
  buildReviewFiles,
  recordedFileVersions,
  reviewBefore,
  reviewLineCounts,
  reviewMatches,
  type ReviewChangeGroup,
  type ReviewFile,
} from "../../lib/change-review";
import type { ChangedFileEntry } from "../../lib/changed-files";
import { highlightLine, languageForPath } from "../../lib/highlight";
import { useI18n } from "../../lib/i18n";
import { diffLines, type DiffRow } from "../../lib/line-diff";
import { parseUnifiedHunks } from "../../lib/revert-change";
import "./change-review.css";

const DiffCodeEditor = lazy(() => import("../../components/ui/DiffCodeEditor"));

export interface ReviewEditorState {
  path: string;
  resolvedPath: string;
  original: string;
  value: string;
  saving: boolean;
  before?: string;
}
interface ReviewArtifact { id: string; name: string; kind: string; content: string }

interface FileSnapshot {
  key: string;
  before?: string;
  after?: string;
  path: string;
  truncated?: boolean;
  recorded?: boolean;
  error?: string;
}

interface RenderLine {
  kind: "same" | "added" | "removed";
  oldLine?: number;
  newLine?: number;
  text: string;
}

type DiffBlock =
  | { type: "lines"; id: string; heading?: string; lines: RenderLine[] }
  | { type: "gap"; id: string; hiddenLines: RenderLine[] };

function shortTailDir(dir: string): string {
  if (!dir) return "";
  const clean = dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (clean.length <= 16) return clean;
  return `…${clean.slice(-15)}`;
}

function fileStatusBadge(entry: ChangedFileEntry): { code: "A" | "M" | "D"; tone: "added" | "modified" | "deleted" } {
  if (entry.kind === "patch") {
    if (entry.changeType === "added") return { code: "A", tone: "added" };
    if (entry.changeType === "deleted") return { code: "D", tone: "deleted" };
    return { code: "M", tone: "modified" };
  }
  const allNew = entry.diffs.length > 0 && entry.diffs.every(diff => !diff.before);
  if (allNew) return { code: "A", tone: "added" };
  return { code: "M", tone: "modified" };
}

function readReviewed(key: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).filter(([, revision]) => typeof revision === "string"));
    }
  } catch { /* Optional UI metadata. */ }
  return {};
}

function splitLinesNormalized(value: string): string[] {
  if (!value) return [];
  const list = value.replace(/\r\n/g, "\n").split("\n");
  if (list.at(-1) === "") list.pop();
  return list;
}

/**
 * Computes line diff with common prefix/suffix trimming so large files stay
 * fast, then folds long unchanged stretches into expandable `+N more lines`
 * gap blocks (matching Antigravity's accordion diff stream).
 */
function buildDiffBlocksFromPair(before: string, after: string, context = 3): DiffBlock[] | null {
  const oldLines = splitLinesNormalized(before);
  const newLines = splitLinesNormalized(after);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const midOld = oldLines.slice(start, oldEnd);
  const midNew = newLines.slice(start, newEnd);
  // If middle slice is too large for exact LCS, signal caller to prefer recorded hunks if available.
  if (midOld.length * midNew.length > 220_000) return null;

  const midRows: DiffRow[] = midOld.length === 0 && midNew.length === 0
    ? []
    : diffLines(midOld.join("\n"), midNew.join("\n"));

  const all: RenderLine[] = [];
  for (let i = 0; i < start; i += 1) {
    all.push({ kind: "same", oldLine: i + 1, newLine: i + 1, text: oldLines[i]! });
  }
  let oLine = start + 1;
  let nLine = start + 1;
  for (const row of midRows) {
    if (row.type === "same") {
      all.push({ kind: "same", oldLine: oLine++, newLine: nLine++, text: row.text });
    } else if (row.type === "removed") {
      all.push({ kind: "removed", oldLine: oLine++, text: row.text });
    } else {
      all.push({ kind: "added", newLine: nLine++, text: row.text });
    }
  }
  for (let i = 0; i < oldLines.length - oldEnd; i += 1) {
    all.push({ kind: "same", oldLine: oLine++, newLine: nLine++, text: oldLines[oldEnd + i]! });
  }

  // Mark lines within `context` of any changed line as visible.
  const keep = new Uint8Array(all.length);
  let hasChange = false;
  for (let i = 0; i < all.length; i += 1) {
    if (all[i]!.kind !== "same") {
      hasChange = true;
      const from = Math.max(0, i - context);
      const to = Math.min(all.length - 1, i + context);
      for (let k = from; k <= to; k += 1) keep[k] = 1;
    }
  }
  if (!hasChange) return [];

  const blocks: DiffBlock[] = [];
  let cursor = 0;
  let blockIndex = 0;
  while (cursor < all.length) {
    if (keep[cursor]) {
      const slice: RenderLine[] = [];
      while (cursor < all.length && keep[cursor]) slice.push(all[cursor++]!);
      blocks.push({ type: "lines", id: `hunk-${blockIndex++}`, lines: slice });
    } else {
      const hidden: RenderLine[] = [];
      while (cursor < all.length && !keep[cursor]) hidden.push(all[cursor++]!);
      // Don't fold tiny 1-line gaps; just show the line directly.
      if (hidden.length <= 1 && blocks.length > 0 && blocks[blocks.length - 1]!.type === "lines") {
        (blocks[blocks.length - 1] as Extract<DiffBlock, { type: "lines" }>).lines.push(...hidden);
      } else {
        blocks.push({ type: "gap", id: `gap-${blockIndex++}`, hiddenLines: hidden });
      }
    }
  }
  return blocks;
}

/** Builds clean red/green hunk blocks directly from recorded fileDiff / unified patch entries. */
function buildDiffBlocksFromEntry(entry: ChangedFileEntry, zh: boolean): DiffBlock[] {
  const chunks = entry.kind === "patch"
    ? parseUnifiedHunks(entry.diff ?? "").map(hunk => ({
        before: hunk.preImage.join("\n"),
        after: hunk.postImage.join("\n"),
        oldLine: hunk.preHintLine as number | undefined,
        newLine: hunk.hintLine as number | undefined,
        heading: `@@ −${hunk.preHintLine},${hunk.preImage.length} +${hunk.hintLine},${hunk.postImage.length} @@`,
      }))
    : entry.diffs.map((fragment, idx) => ({
        before: fragment.before,
        after: fragment.after,
        oldLine: undefined as number | undefined,
        newLine: undefined as number | undefined,
        heading: entry.diffs.length > 1
          ? `${zh ? "修改片段" : "Edit"} ${idx + 1}${fragment.truncated ? (zh ? " · 已截断" : " · Truncated") : ""}`
          : undefined,
      }));

  const blocks: DiffBlock[] = [];
  chunks.forEach((chunk, idx) => {
    const lines: RenderLine[] = [];
    let oLine = chunk.oldLine;
    let nLine = chunk.newLine;
    for (const row of diffLines(chunk.before, chunk.after)) {
      if (row.text === "" && ((row.type === "removed" && chunk.before === "") || (row.type === "added" && chunk.after === ""))) {
        continue;
      }
      if (row.type === "same") {
        lines.push({ kind: "same", oldLine: oLine, newLine: nLine, text: row.text });
        if (oLine !== undefined) oLine += 1;
        if (nLine !== undefined) nLine += 1;
      } else if (row.type === "removed") {
        lines.push({ kind: "removed", oldLine: oLine, text: row.text });
        if (oLine !== undefined) oLine += 1;
      } else {
        lines.push({ kind: "added", newLine: nLine, text: row.text });
        if (nLine !== undefined) nLine += 1;
      }
    }
    if (lines.length > 0) {
      blocks.push({ type: "lines", id: `rec-${idx}`, heading: chunk.heading, lines });
    }
  });
  return blocks;
}

interface SplitPair {
  left?: RenderLine;
  right?: RenderLine;
}

function toSplitPairs(lines: RenderLine[]): SplitPair[] {
  const out: SplitPair[] = [];
  let removed: RenderLine[] = [];
  let added: RenderLine[] = [];
  const flush = (): void => {
    const count = Math.max(removed.length, added.length);
    for (let i = 0; i < count; i += 1) {
      out.push({ left: removed[i], right: added[i] });
    }
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === "same") {
      flush();
      out.push({ left: line, right: line });
    } else if (line.kind === "removed") {
      removed.push(line);
    } else {
      added.push(line);
    }
  }
  flush();
  return out;
}

function DiffLinesTable({
  lines,
  language,
  split,
}: {
  lines: RenderLine[];
  language?: string;
  split: boolean;
}): JSX.Element {
  const [limit, setLimit] = useState(260);
  const { locale } = useI18n();
  const zh = locale === "zh-CN";

  if (split) {
    const pairs = toSplitPairs(lines);
    const shown = pairs.slice(0, limit);
    return (
      <div className="review-hunk-split">
        {shown.map((pair, idx) => (
          <div key={idx} className="review-split-row">
            <div className={`review-diff-line is-${pair.left?.kind ?? "empty"}`}>
              <span className="review-ln">{pair.left?.oldLine ?? ""}</span>
              <span className="review-sign">{pair.left?.kind === "removed" ? "−" : ""}</span>
              <code dangerouslySetInnerHTML={{ __html: pair.left ? highlightLine(pair.left.text || " ", language) : " " }} />
            </div>
            <div className={`review-diff-line is-${pair.right?.kind ?? "empty"}`}>
              <span className="review-ln">{pair.right?.newLine ?? ""}</span>
              <span className="review-sign">{pair.right?.kind === "added" ? "+" : ""}</span>
              <code dangerouslySetInnerHTML={{ __html: pair.right ? highlightLine(pair.right.text || " ", language) : " " }} />
            </div>
          </div>
        ))}
        {pairs.length > limit && (
          <button type="button" className="review-more-lines" onClick={() => setLimit(v => v + 400)}>
            {zh ? `+ 展开剩余 ${pairs.length - limit} 行` : `+${pairs.length - limit} more lines`}
          </button>
        )}
      </div>
    );
  }

  const shown = lines.slice(0, limit);
  return (
    <div className="review-hunk-unified">
      {shown.map((line, idx) => (
        <div key={idx} className={`review-diff-line is-${line.kind}`}>
          <span className="review-ln">{line.kind === "removed" ? (line.oldLine ?? "") : (line.newLine ?? line.oldLine ?? "")}</span>
          <span className="review-sign">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}</span>
          <code dangerouslySetInnerHTML={{ __html: highlightLine(line.text || " ", language) }} />
        </div>
      ))}
      {lines.length > limit && (
        <button type="button" className="review-more-lines" onClick={() => setLimit(v => v + 400)}>
          {zh ? `+ 展开剩余 ${lines.length - limit} 行` : `+${lines.length - limit} more lines`}
        </button>
      )}
    </div>
  );
}

function ReviewFileCard({
  file,
  expanded,
  active,
  reviewed,
  split,
  counts,
  projectRoot,
  refreshVersion,
  editor,
  editLoading,
  revertArmed,
  reverting,
  onToggleExpand,
  onSelect,
  onToggleReviewed,
  onEdit,
  onCancelEdit,
  onSaveEdit,
  onEditorChange,
  onRevert,
  onCountsLoaded,
  registerRef,
}: {
  file: ReviewFile;
  expanded: boolean;
  active: boolean;
  reviewed: boolean;
  split: boolean;
  counts?: { additions: number; deletions: number };
  projectRoot?: string;
  refreshVersion: number;
  editor: ReviewEditorState | null;
  editLoading: boolean;
  revertArmed: boolean;
  reverting: boolean;
  onToggleExpand: () => void;
  onSelect: () => void;
  onToggleReviewed: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onEditorChange: (value: string) => void;
  onRevert: () => void;
  onCountsLoaded: (id: string, key: string, counts?: { additions: number; deletions: number }) => void;
  registerRef: (id: string, node: HTMLElement | null) => void;
}): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const isEditing = Boolean(editor && editor.path === file.entry.path);
  const snapshotKey = `${file.id}:${file.revision}:${refreshVersion}`;
  const [snapshot, setSnapshot] = useState<FileSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedGaps, setExpandedGaps] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setExpandedGaps(new Set());
  }, [snapshotKey]);

  useEffect(() => {
    if (!expanded || isEditing || !window.agenthub) return;
    if (snapshot?.key === snapshotKey) return;
    let cancelled = false;
    setLoading(true);
    void window.agenthub.files.readText({ path: file.entry.path, basePaths: projectRoot ? [projectRoot] : [] })
      .then(result => {
        if (cancelled) return;
        if (!result.ok) {
          const saved = result.reason === "not-found" ? recordedFileVersions(file.entry) : undefined;
          if (saved) {
            setSnapshot({ key: snapshotKey, before: saved.before, after: saved.after, path: file.entry.path, recorded: true });
            return;
          }
          setSnapshot({
            key: snapshotKey,
            path: file.entry.path,
            error: result.reason === "binary" ? (zh ? "二进制文件，暂不支持文本对比" : "Binary file") : undefined,
          });
          return;
        }
        const before = result.truncated ? undefined : reviewBefore(file.entry, result.content);
        const computed = before === undefined ? undefined : reviewLineCounts(before, result.content);
        if (computed) onCountsLoaded(file.id, `${file.revision}:${refreshVersion}`, computed);
        setSnapshot({
          key: snapshotKey,
          before,
          after: result.content,
          path: result.resolvedPath,
          truncated: result.truncated,
        });
      })
      .catch(err => {
        if (!cancelled) setSnapshot({ key: snapshotKey, path: file.entry.path, error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, isEditing, snapshotKey, file.entry, file.id, file.revision, projectRoot, refreshVersion, zh, onCountsLoaded, snapshot?.key]);

  const language = languageForPath(file.entry.path);
  const blocks = useMemo<DiffBlock[]>(() => {
    if (!expanded || isEditing) return [];
    const activeSnap = snapshot?.key === snapshotKey ? snapshot : null;
    if (activeSnap && activeSnap.before !== undefined && activeSnap.after !== undefined) {
      const liveBlocks = buildDiffBlocksFromPair(activeSnap.before, activeSnap.after, 3);
      if (liveBlocks !== null) return liveBlocks;
    }
    // Always prefer recorded red/green hunks over dumping thousands of unhighlighted lines!
    const recorded = buildDiffBlocksFromEntry(file.entry, zh);
    if (recorded.length > 0) return recorded;
    // Fallback for brand-new file with full content only
    if (activeSnap?.after !== undefined) {
      const addedLines: RenderLine[] = splitLinesNormalized(activeSnap.after).map((text, idx) => ({
        kind: "added",
        newLine: idx + 1,
        text,
      }));
      return addedLines.length ? [{ type: "lines", id: "new-file", lines: addedLines }] : [];
    }
    return [];
  }, [expanded, isEditing, snapshot, snapshotKey, file.entry, zh]);

  const currentSnap = snapshot?.key === snapshotKey ? snapshot : null;
  const badge = fileStatusBadge(file.entry);

  return (
    <section
      ref={node => registerRef(file.id, node)}
      className="review-card"
      data-expanded={expanded || undefined}
      data-active={active || undefined}
      data-reviewed={reviewed || undefined}
    >
      <div className="review-card-head">
        <button
          type="button"
          className="review-card-toggle"
          aria-expanded={expanded}
          onClick={() => {
            onSelect();
            onToggleExpand();
          }}
        >
          <FileTypeIcon path={file.entry.path} size={14} />
          <span className="review-card-name">{file.name}</span>
          {file.directory && <span className="review-card-dir" title={file.entry.path}>{file.directory}</span>}
        </button>

        <div className="review-card-meta">
          {isEditing && editor ? (
            <div className="review-edit-actions">
              <button type="button" onClick={onCancelEdit} disabled={editor.saving}>
                {zh ? "取消" : "Cancel"}
              </button>
              <button
                type="button"
                className="review-save"
                disabled={editor.saving || editor.value.replace(/\r\n/g, "\n") === editor.original.replace(/\r\n/g, "\n")}
                onClick={onSaveEdit}
              >
                {editor.saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                {zh ? "保存" : "Save"}
              </button>
            </div>
          ) : (
            <div className="review-card-actions">
              <button
                type="button"
                className="review-card-btn"
                disabled={editLoading}
                onClick={event => {
                  event.stopPropagation();
                  onSelect();
                  if (!expanded) onToggleExpand();
                  onEdit();
                }}
                title={zh ? "编辑文件" : "Edit file"}
                aria-label={zh ? "编辑文件" : "Edit file"}
              >
                <Pencil size={12} aria-hidden />
              </button>
              <button
                type="button"
                className={`review-card-btn${revertArmed && active ? " is-danger" : ""}`}
                disabled={reverting || (file.entry.kind === "patch" && (file.entry.comparisonUnavailable || file.entry.changeType === "deleted"))}
                onClick={event => {
                  event.stopPropagation();
                  onSelect();
                  onRevert();
                }}
                title={revertArmed && active ? (zh ? "再次点击确认撤销" : "Click again to confirm revert") : (zh ? "撤销此文件改动" : "Revert file changes")}
                aria-label={zh ? "撤销此文件改动" : "Revert file changes"}
              >
                <RotateCcw size={12} aria-hidden />
                {revertArmed && active && <span>{zh ? "确认撤销" : "Confirm"}</span>}
              </button>
              <button
                type="button"
                className={`review-card-btn${reviewed ? " is-done" : ""}`}
                aria-pressed={reviewed}
                onClick={event => {
                  event.stopPropagation();
                  onToggleReviewed();
                }}
                title={reviewed ? (zh ? "已查看（点击取消）" : "Reviewed") : (zh ? "标记为已查看" : "Mark as reviewed")}
                aria-label={reviewed ? (zh ? "已查看" : "Reviewed") : (zh ? "标记为已查看" : "Mark as reviewed")}
              >
                <Check size={12} aria-hidden />
              </button>
            </div>
          )}

          {counts && (counts.additions > 0 || counts.deletions > 0) ? (
            <span className="review-card-counts">
              {counts.additions > 0 && <b className="review-added">+{counts.additions}</b>}
              {counts.deletions > 0 && <em className="review-removed">−{counts.deletions}</em>}
            </span>
          ) : (
            <span className="review-file-status" data-tone={badge.tone}>{badge.code}</span>
          )}

          <button
            type="button"
            className="review-card-chevron"
            onClick={() => {
              onSelect();
              onToggleExpand();
            }}
            aria-label={expanded ? (zh ? "折叠" : "Collapse") : (zh ? "展开" : "Expand")}
          >
            {expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="review-card-body">
          {isEditing && editor ? (
            <div className="review-inline-editor">
              <Suspense fallback={<div className="review-card-status"><Loader2 size={14} className="animate-spin" />{zh ? "加载编辑器…" : "Loading editor…"}</div>}>
                <DiffCodeEditor
                  key={`${editor.resolvedPath}:${editor.before === undefined ? "single" : "diff"}`}
                  before={editor.before}
                  value={editor.value}
                  filePath={editor.resolvedPath}
                  appearance="review"
                  readOnly={false}
                  sideBySide={split && editor.before !== undefined}
                  onChange={onEditorChange}
                />
              </Suspense>
            </div>
          ) : loading && blocks.length === 0 ? (
            <div className="review-card-status" role="status">
              <Loader2 size={13} className="animate-spin" />
              <span>{zh ? "计算差异…" : "Computing diff…"}</span>
            </div>
          ) : currentSnap?.error && blocks.length === 0 ? (
            <div className="review-card-status">{currentSnap.error}</div>
          ) : blocks.length === 0 ? (
            <div className="review-card-status">
              {file.entry.kind === "patch" && file.entry.comparisonUnavailable
                ? (zh ? "此文件未采集到基线，无法展示行级差异" : "Baseline unavailable for line diff")
                : (zh ? "无净文本改动" : "No net text changes")}
            </div>
          ) : (
            <div className="review-hunk-stack">
              {currentSnap?.recorded && (
                <div className="review-recorded-banner">
                  {zh ? "原文件已不存在，显示记录的变更差异" : "Showing recorded diff (file no longer on disk)"}
                </div>
              )}
              {blocks.map(block => {
                if (block.type === "gap") {
                  if (expandedGaps.has(block.id)) {
                    return <DiffLinesTable key={block.id} lines={block.hiddenLines} language={language} split={split} />;
                  }
                  return (
                    <div key={block.id} className="review-gap-row">
                      <button
                        type="button"
                        className="review-gap-pill"
                        onClick={() => setExpandedGaps(prev => new Set(prev).add(block.id))}
                      >
                        {zh ? `+ 展开其余 ${block.hiddenLines.length} 行` : `+${block.hiddenLines.length} more lines`}
                      </button>
                    </div>
                  );
                }
                return (
                  <div key={block.id} className="review-hunk-block">
                    {block.heading && <div className="review-hunk-meta">{block.heading}</div>}
                    <DiffLinesTable lines={block.lines} language={language} split={split} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function ChangeReview({
  groups,
  projectRoot,
  sessionId,
  selectedIndex,
  onSelect,
  editor,
  onEditorChange,
  onEdit,
  onCancelEdit,
  onSaveEdit,
  onRevert,
  editLoading,
  revertArmed,
  reverting,
  refreshVersion,
  artifacts,
  sourceContent,
  sourceCount,
  comparisonUnavailable,
}: {
  groups: ReviewChangeGroup[];
  projectRoot?: string;
  sessionId?: string;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
  editor: ReviewEditorState | null;
  onEditorChange: (value: string) => void;
  onEdit: (entry: ChangedFileEntry) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onRevert: (entry: ChangedFileEntry) => void;
  editLoading: boolean;
  revertArmed: boolean;
  reverting: boolean;
  refreshVersion: number;
  artifacts: ReviewArtifact[];
  sourceContent: ReactNode;
  sourceCount: number;
  comparisonUnavailable: boolean;
}): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const files = useMemo(() => buildReviewFiles(groups, projectRoot), [groups, projectRoot]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [view, setView] = useState("diff");
  const [mode, setMode] = useState<"split" | "unified">("unified");
  const [filesOpen, setFilesOpen] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [reviewed, setReviewed] = useState<Record<string, string>>({});
  const storageKey = `nautilo.changes.review.v1:${sessionId ?? "current"}`;
  const [netCounts, setNetCounts] = useState<Record<string, { key: string; counts?: { additions: number; deletions: number } }>>({});
  const countCache = useRef(netCounts);
  countCache.current = netCounts;

  useEffect(() => {
    setReviewed(readReviewed(storageKey));
    setView("diff");
    setQuery("");
    setFilter("all");
  }, [storageKey]);

  // Auto-expand the selected file on initial mount / session change (keeping other files stacked cleanly).
  const autoExpandedSession = useRef<string>("");
  useEffect(() => {
    const selected = files[selectedIndex] ?? files[0];
    if (!selected) return;
    const key = `${sessionId ?? "current"}:${selected.id}`;
    if (autoExpandedSession.current.startsWith(`${sessionId ?? "current"}:`)) return;
    autoExpandedSession.current = key;
    setExpandedIds(new Set([selected.id]));
  }, [files, selectedIndex, sessionId]);

  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Background exact line-count verification across all changed files.
  const fileSetKey = files.map(file => `${file.id}:${file.revision}`).join("\n");
  useEffect(() => {
    const bridge = window.agenthub;
    if (!bridge) return;
    let cancelled = false;
    const queue = files.filter(file => countCache.current[file.id]?.key !== `${file.revision}:${refreshVersion}`);
    const worker = async (): Promise<void> => {
      while (!cancelled && queue.length) {
        const file = queue.shift()!;
        let counts: { additions: number; deletions: number } | undefined;
        try {
          const result = await bridge.files.readText({ path: file.entry.path, basePaths: projectRoot ? [projectRoot] : [] });
          if (result.ok && !result.truncated) {
            const original = reviewBefore(file.entry, result.content);
            if (original !== undefined) counts = reviewLineCounts(original, result.content);
          }
        } catch { /* Unknown totals fallback to recorded counts. */ }
        if (!cancelled) {
          setNetCounts(current => ({ ...current, [file.id]: { key: `${file.revision}:${refreshVersion}`, counts } }));
        }
      }
    };
    void Promise.all([worker(), worker()]);
    return () => { cancelled = true; };
  }, [fileSetKey, projectRoot, refreshVersion]);

  const handleCountsLoaded = useCallback((id: string, key: string, counts?: { additions: number; deletions: number }) => {
    setNetCounts(current => ({ ...current, [id]: { key, counts } }));
  }, []);

  const registerCardRef = useCallback((id: string, node: HTMLElement | null) => {
    if (node) cardRefs.current.set(id, node);
    else cardRefs.current.delete(id);
  }, []);

  const isReviewed = (file: ReviewFile): boolean => reviewed[file.id] === file.revision;
  const readCount = files.filter(isReviewed).length;
  const countsFor = (file: ReviewFile): { additions: number; deletions: number } | undefined => {
    const verified = netCounts[file.id];
    if (verified?.key === `${file.revision}:${refreshVersion}` && verified.counts) return verified.counts;
    return file.additions !== undefined && file.deletions !== undefined && !(file.entry.kind === "patch" && file.entry.comparisonUnavailable)
      ? { additions: file.additions, deletions: file.deletions }
      : undefined;
  };
  const hasCounts = files.some(file => countsFor(file) !== undefined);
  const totals = files.reduce(
    (sum, file) => {
      const counts = countsFor(file);
      return { added: sum.added + (counts?.additions ?? 0), removed: sum.removed + (counts?.deletions ?? 0) };
    },
    { added: 0, removed: 0 },
  );

  const visible = files.filter(file => reviewMatches(file, query) && (filter !== "unread" || !isReviewed(file)));
  const groupedFiles = new Map<string, { label: string; files: ReviewFile[] }>();
  for (const file of visible) {
    const key = file.group || "__root__";
    const group = groupedFiles.get(key) ?? { label: file.group, files: [] };
    group.files.push(file);
    groupedFiles.set(key, group);
  }

  const artifactTabs = [
    { id: "test_report", label: zh ? "测试报告" : "Test reports" },
    { id: "api_contract", label: zh ? "API 契约" : "API contracts" },
    { id: "commit", label: zh ? "提交" : "Commits" },
  ]
    .map(tab => ({ ...tab, items: artifacts.filter(item => item.kind === tab.id) }))
    .filter(tab => tab.items.length);
  const activeArtifact = artifactTabs.find(tab => tab.id === view);
  const tests = artifactTabs.find(tab => tab.id === "test_report");

  const toggleReviewedFile = (file: ReviewFile): void => {
    const next = { ...reviewed };
    if (isReviewed(file)) delete next[file.id];
    else next[file.id] = file.revision;
    setReviewed(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(Object.entries(next).slice(-512))));
    } catch { /* Keep in-memory mark. */ }
  };

  const toggleExpand = (id: string): void => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allExpanded = visible.length > 0 && visible.every(file => expandedIds.has(file.id));
  const toggleExpandAll = (): void => {
    if (allExpanded) setExpandedIds(new Set());
    else setExpandedIds(new Set(visible.map(file => file.id)));
  };

  const jumpToFile = (file: ReviewFile): void => {
    if (editor?.saving) return;
    setView("diff");
    onSelect(file.index);
    setExpandedIds(prev => {
      if (prev.has(file.id)) return prev;
      const next = new Set(prev);
      next.add(file.id);
      return next;
    });
    requestAnimationFrame(() => {
      cardRefs.current.get(file.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <div className="change-review" data-files-hidden={!filesOpen || undefined} aria-label={zh ? "文件更改" : "File changes"}>
      <main className="review-main">
        <header className="review-main-heading">
          <div className="review-document">
            <span className="review-summary-label">
              {view === "sources"
                ? (zh ? "原始差异记录" : "Recorded comparisons")
                : activeArtifact?.label ?? (zh ? `已更改 · ${visible.length} 个文件` : `${visible.length} changed`)}
            </span>
            {view === "diff" && hasCounts && (
              <span className="review-inline-totals">
                <span className="review-added">+{totals.added}</span>
                <span className="review-removed">−{totals.removed}</span>
              </span>
            )}
          </div>

          <div className="review-toolbar">
            {view === "diff" && visible.length > 0 && (
              <button
                type="button"
                className="review-icon-button"
                onClick={toggleExpandAll}
                title={allExpanded ? (zh ? "折叠全部文件" : "Collapse all files") : (zh ? "展开全部文件" : "Expand all files")}
                aria-label={allExpanded ? (zh ? "折叠全部文件" : "Collapse all files") : (zh ? "展开全部文件" : "Expand all files")}
              >
                {allExpanded ? <ChevronsDownUp size={14} aria-hidden /> : <ChevronsUpDown size={14} aria-hidden />}
              </button>
            )}

            {view === "diff" && (
              <div className="review-view-switch" role="group" aria-label={zh ? "对比视图" : "Diff view"}>
                <button type="button" aria-pressed={mode === "unified"} onClick={() => setMode("unified")}>
                  <List size={12} />
                  {zh ? "合并" : "Unified"}
                </button>
                <button type="button" aria-pressed={mode === "split"} onClick={() => setMode("split")}>
                  <Columns2 size={12} />
                  {zh ? "并排" : "Split"}
                </button>
              </div>
            )}

            {(sourceCount > 0 || artifactTabs.length > 0 || view !== "diff") && (
              <div className="review-menu-anchor" ref={menuRef}>
                <button
                  type="button"
                  className="review-icon-button"
                  title={zh ? "更多视图" : "More views"}
                  aria-label={zh ? "更多视图" : "More views"}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen(v => !v)}
                >
                  <MoreHorizontal size={15} />
                </button>
                {menuOpen && (
                  <div className="review-menu" role="menu">
                    {view !== "diff" && (
                      <button type="button" role="menuitem" onClick={() => { setView("diff"); setMenuOpen(false); }}>
                        <FileCode2 size={13} />
                        {zh ? "文件更改流" : "Changed files"}
                      </button>
                    )}
                    {!!sourceCount && (
                      <button type="button" role="menuitem" onClick={() => { setView("sources"); setMenuOpen(false); }}>
                        <History size={13} />
                        {zh ? "原始差异记录" : "Recorded comparisons"}
                        <span>{sourceCount}</span>
                      </button>
                    )}
                    {artifactTabs.map(tab => (
                      <button type="button" role="menuitem" key={tab.id} onClick={() => { setView(tab.id); setMenuOpen(false); }}>
                        <FileCode2 size={13} />
                        {tab.label}
                        <span>{tab.items.length}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              className="review-icon-button"
              aria-pressed={filesOpen}
              onClick={() => setFilesOpen(v => !v)}
              title={filesOpen ? (zh ? "隐藏右侧文件栏" : "Hide file list") : (zh ? "显示右侧文件栏" : "Show file list")}
              aria-label={filesOpen ? (zh ? "隐藏右侧文件栏" : "Hide file list") : (zh ? "显示右侧文件栏" : "Show file list")}
            >
              <PanelRight size={14} aria-hidden />
            </button>
          </div>
        </header>

        <section className="review-code-workspace" aria-label={zh ? "文件差异流" : "Diff stream"}>
          {view === "diff" ? (
            visible.length === 0 ? (
              <div className="review-empty">
                <FileCode2 size={24} />
                <p>
                  {query
                    ? (zh ? "没有匹配的文件" : "No matching files")
                    : filter === "unread" && files.length > 0
                      ? (zh ? "所有文件更改均已审阅" : "All changed files reviewed")
                      : comparisonUnavailable
                        ? (zh ? "没有可读取的差异详情" : "No readable diff details")
                        : (zh ? "本次会话暂无文件更改" : "No file changes yet")}
                </p>
                {!!sourceCount && (
                  <button type="button" onClick={() => setView("sources")}>
                    {zh ? "查看原始差异记录" : "View recorded comparisons"}
                    <ChevronRight size={12} />
                  </button>
                )}
              </div>
            ) : (
              <div className="review-stream">
                {visible.map(file => (
                  <ReviewFileCard
                    key={file.id}
                    file={file}
                    expanded={expandedIds.has(file.id)}
                    active={file.index === selectedIndex}
                    reviewed={isReviewed(file)}
                    split={mode === "split"}
                    counts={countsFor(file)}
                    projectRoot={projectRoot}
                    refreshVersion={refreshVersion}
                    editor={editor}
                    editLoading={editLoading}
                    revertArmed={revertArmed}
                    reverting={reverting}
                    onToggleExpand={() => toggleExpand(file.id)}
                    onSelect={() => onSelect(file.index)}
                    onToggleReviewed={() => toggleReviewedFile(file)}
                    onEdit={() => onEdit(file.entry)}
                    onCancelEdit={onCancelEdit}
                    onSaveEdit={onSaveEdit}
                    onEditorChange={onEditorChange}
                    onRevert={() => onRevert(file.entry)}
                    onCountsLoaded={handleCountsLoaded}
                    registerRef={registerCardRef}
                  />
                ))}
              </div>
            )
          ) : view === "sources" ? (
            <div className="review-source-records">{sourceContent}</div>
          ) : (
            <div className="review-artifact-records">
              {activeArtifact?.items.map(artifact => (
                <section key={artifact.id}>
                  <h4>{artifact.name}</h4>
                  <pre>{artifact.content}</pre>
                </section>
              ))}
            </div>
          )}
        </section>
      </main>

      {filesOpen && (
        <nav className="review-files" aria-label={zh ? "更改文件" : "Changed files"}>
          <div className="review-files-heading">
            <h2>
              {zh ? "更改" : "Changes"}
              <span>{files.length}</span>
            </h2>
          </div>
          <label className="review-search">
            <Search size={12} aria-hidden />
            <input
              aria-label={zh ? "筛选文件" : "Filter files"}
              placeholder={zh ? "筛选文件…" : "Filter files…"}
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
            {query && (
              <button type="button" aria-label={zh ? "清空筛选" : "Clear filter"} onClick={() => setQuery("")}>
                <X size={12} />
              </button>
            )}
          </label>
          <div className="review-file-filters" role="group" aria-label={zh ? "文件筛选" : "File filters"}>
            <button type="button" aria-pressed={filter === "all" && view === "diff"} onClick={() => { setFilter("all"); setView("diff"); }}>
              {zh ? "全部" : "All"}
            </button>
            <button type="button" aria-pressed={filter === "unread" && view === "diff"} onClick={() => { setFilter("unread"); setView("diff"); }}>
              {zh ? "未查看" : "Unreviewed"}
              <span>{files.length - readCount}</span>
            </button>
            {tests && (
              <button type="button" aria-pressed={view === "test_report"} onClick={() => setView("test_report")}>
                {zh ? "测试" : "Tests"}
                <span>{tests.items.length}</span>
              </button>
            )}
          </div>
          <div className="review-file-tree">
            {[...groupedFiles].map(([key, group]) => (
              <section key={key}>
                {group.label && (
                  <button
                    type="button"
                    className="review-directory"
                    aria-expanded={!collapsedGroups.has(key)}
                    onClick={() =>
                      setCollapsedGroups(prev => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })
                    }
                  >
                    <ChevronDown size={11} className={collapsedGroups.has(key) ? "is-collapsed" : ""} />
                    <Folder size={11} />
                    <span title={group.label}>{group.label}</span>
                  </button>
                )}
                {!collapsedGroups.has(key) &&
                  group.files.map(file => {
                    const badge = fileStatusBadge(file.entry);
                    const tail = shortTailDir(file.directory);
                    const reviewedFile = isReviewed(file);
                    const isSelected = file.index === selectedIndex && view === "diff";
                    return (
                      <button
                        type="button"
                        key={file.id}
                        className={`review-file${isSelected ? " is-current" : ""}`}
                        aria-current={isSelected ? "true" : undefined}
                        title={file.entry.path}
                        onClick={() => jumpToFile(file)}
                      >
                        <FileTypeIcon path={file.entry.path} />
                        <span className="review-file-name">{file.name}</span>
                        {tail && <span className="review-file-tail" title={file.directory}>{tail}</span>}
                        {reviewedFile ? (
                          <Check size={12} className="review-file-check" aria-label={zh ? "已查看" : "Reviewed"} />
                        ) : (
                          <span className="review-file-status" data-tone={badge.tone} aria-label={badge.tone}>
                            {badge.code}
                          </span>
                        )}
                      </button>
                    );
                  })}
              </section>
            ))}
            {!visible.length && (
              <p className="review-no-matches">
                {query
                  ? (zh ? "没有匹配的文件" : "No matching files")
                  : filter === "unread" && files.length
                    ? (zh ? "全部已查看" : "All files reviewed")
                    : (zh ? "暂无文件更改" : "No file changes")}
              </p>
            )}
          </div>
          <div className="review-file-progress">
            <span>
              <Check size={11} />
              {zh ? "已查看" : "Reviewed"} {readCount} / {files.length}
            </span>
            <div role="progressbar" aria-label={zh ? "审阅进度" : "Review progress"} aria-valuemin={0} aria-valuemax={Math.max(1, files.length)} aria-valuenow={readCount}>
              <i style={{ width: `${files.length ? (readCount / files.length) * 100 : 0}%` }} />
            </div>
          </div>
        </nav>
      )}
    </div>
  );
}
