import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Columns2, FileCode2, Folder, History, List, Loader2, MoreHorizontal, Pencil, RotateCcw, Search, X } from "lucide-react";
import { FileTypeIcon } from "../../components/ui/FileTypeIcon";
import type { DiffReviewNavigation, DiffReviewPosition } from "../../components/ui/DiffCodeEditor";
import { buildReviewFiles, recordedFileVersions, reviewBefore, reviewLineCounts, reviewMatches, type ReviewChangeGroup, type ReviewFile } from "../../lib/change-review";
import type { ChangedFileEntry } from "../../lib/changed-files";
import { useI18n } from "../../lib/i18n";
import { RecordedChangeReview } from "./RecordedChangeReview";
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
interface ReviewSnapshot { key: string; before?: string; after: string; path: string; truncated: boolean; recorded?: boolean }

function readReviewed(key: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).filter(([, revision]) => typeof revision === "string"));
  } catch { /* Review marks are optional UI metadata, never file contents. */ }
  return {};
}

export function ChangeReview({ groups, projectRoot, sessionId, selectedIndex, onSelect, onClose, editor, onEditorChange, onEdit, onCancelEdit, onSaveEdit, onRevert, editLoading, revertArmed, reverting, refreshVersion, artifacts, sourceContent, sourceCount, comparisonUnavailable }: {
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
  const selected = files[selectedIndex];
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [view, setView] = useState("diff");
  const [mode, setMode] = useState<"split" | "unified">("split");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [menuOpen, setMenuOpen] = useState<"files" | "editor" | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const [reviewed, setReviewed] = useState<Record<string, string>>({});
  const storageKey = `nautilo.changes.review.v1:${sessionId ?? "current"}`;
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState("");
  const [reload, setReload] = useState(0);
  const [netCounts, setNetCounts] = useState<Record<string, { key: string; counts?: { additions: number; deletions: number } }>>({});
  const countCache = useRef(netCounts);
  countCache.current = netCounts;
  const [position, setPosition] = useState<DiffReviewPosition>({ index: 0, count: 0 });
  const navigationRef = useRef<DiffReviewNavigation | null>(null);
  const snapshotKey = selected ? `${selected.id}:${selected.revision}:${refreshVersion}` : "";
  const selectedEntry = useRef(selected?.entry);
  selectedEntry.current = selected?.entry;

  useEffect(() => { setReviewed(readReviewed(storageKey)); setView("diff"); setQuery(""); setFilter("all"); }, [storageKey]);
  useEffect(() => { setMenuOpen(null); setPosition({ index: 0, count: 0 }); }, [selected?.id, view]);
  useEffect(() => {
    if (!menuOpen) return;
    const node = menuOpen === "files" ? fileMenuRef.current : menuRef.current;
    const outside = (event: PointerEvent): void => { if (!node?.contains(event.target as Node)) setMenuOpen(null); };
    const key = (event: KeyboardEvent): void => { if (event.key === "Escape") { event.stopPropagation(); setMenuOpen(null); node?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", outside);
    node?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus();
    node?.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside); node?.removeEventListener("keydown", key); };
  }, [menuOpen]);
  useEffect(() => {
    setSnapshot(null);
    setReadError("");
    setPosition({ index: 0, count: 0 });
    const entry = selectedEntry.current;
    if (!entry || view !== "diff" || !window.agenthub) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void window.agenthub.files.readText({ path: entry.path, basePaths: projectRoot ? [projectRoot] : [] }).then(result => {
      if (cancelled) return;
      if (!result.ok) {
        const saved = result.reason === "not-found" ? recordedFileVersions(entry) : undefined;
        if (saved) {
          setSnapshot({ key: snapshotKey, ...saved, path: entry.path, truncated: false, recorded: true });
          return;
        }
        setReadError(result.reason === "binary" ? (zh ? "此文件不是文本文件" : "This is not a text file") : result.reason === "ambiguous" ? (zh ? "匹配到多个文件，无法确定文件路径" : "More than one file matches this path") : (zh ? "无法读取当前文件" : "Unable to read the current file"));
        return;
      }
      const before = result.truncated ? undefined : reviewBefore(entry, result.content);
      const counts = before === undefined ? undefined : reviewLineCounts(before, result.content);
      if (selected) setNetCounts(current => ({ ...current, [selected.id]: { key: `${selected.revision}:${refreshVersion}:${reload}`, counts } }));
      // Reading the current file and recovering its historical baseline are
      // independent. Losing the baseline must never discard a readable file.
      setSnapshot({ key: snapshotKey, before, after: result.content, path: result.resolvedPath, truncated: result.truncated });
    }).catch(error => { if (!cancelled) setReadError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [snapshotKey, projectRoot, view, reload, zh]);

  const fileSetKey = files.map(file => `${file.id}:${file.revision}`).join("\n");
  useEffect(() => {
    const bridge = window.agenthub;
    if (!bridge) return;
    let cancelled = false;
    const queue = files.filter(file => file.id !== selected?.id && countCache.current[file.id]?.key !== `${file.revision}:${refreshVersion}:${reload}`);
    // Verify the whole list, not only the opened file. Receipts are not a
    // baseline: a rewrite can contain hundreds of unchanged lines.
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
        } catch { /* An unreadable historical file has unknown totals, not zero. */ }
        if (!cancelled) setNetCounts(current => ({ ...current, [file.id]: { key: `${file.revision}:${refreshVersion}:${reload}`, counts } }));
      }
    };
    void Promise.all([worker(), worker()]);
    return () => { cancelled = true; };
  }, [fileSetKey, projectRoot, refreshVersion, reload]);

  const isReviewed = (file: ReviewFile): boolean => reviewed[file.id] === file.revision;
  const readCount = files.filter(isReviewed).length;
  const countsFor = (file: ReviewFile): { additions: number; deletions: number } | undefined => {
    const verified = netCounts[file.id];
    if (verified?.key === `${file.revision}:${refreshVersion}:${reload}` && verified.counts) return verified.counts;
    // Recorded diffs remain valid history if the current file has gone away.
    // Plain write-tool bodies were excluded before building this list.
    return file.additions !== undefined && file.deletions !== undefined && !(file.entry.kind === "patch" && file.entry.comparisonUnavailable)
      ? { additions: file.additions, deletions: file.deletions } : undefined;
  };
  const hasCounts = files.some(file => countsFor(file) !== undefined);
  const totals = files.reduce((sum, file) => { const counts = countsFor(file); return { added: sum.added + (counts?.additions ?? 0), removed: sum.removed + (counts?.deletions ?? 0) }; }, { added: 0, removed: 0 });
  const selectedCounts = selected ? countsFor(selected) : undefined;
  const visible = files.filter(file => reviewMatches(file, query) && (filter !== "unread" || !isReviewed(file)));
  const directories = new Map<string, { label: string; files: ReviewFile[] }>();
  for (const file of visible) {
    const key = JSON.stringify([file.group, file.directory]);
    const group = directories.get(key) ?? { label: [file.group, file.directory].filter(Boolean).join(" · "), files: [] };
    group.files.push(file); directories.set(key, group);
  }
  const artifactTabs = [
    { id: "test_report", label: zh ? "测试报告" : "Test reports" },
    { id: "api_contract", label: zh ? "API 契约" : "API contracts" },
    { id: "commit", label: zh ? "提交" : "Commits" }
  ].map(tab => ({ ...tab, items: artifacts.filter(item => item.kind === tab.id) })).filter(tab => tab.items.length);
  const activeArtifact = artifactTabs.find(tab => tab.id === view);
  const tests = artifactTabs.find(tab => tab.id === "test_report");
  const preview = snapshot?.key === snapshotKey ? snapshot : null;
  const fileName = selected?.name ?? (zh ? "文件更改" : "File changes");
  const before = editor ? editor.before : preview?.before;
  const after = editor?.value ?? preview?.after;
  const canCompare = after !== undefined;
  const showRecorded = !!selected && !editor && !loading && !canCompare && (selected.entry.kind === "fileDiff" || !!selected.entry.diff && !selected.entry.comparisonUnavailable);
  const split = mode === "split" && (before !== undefined || showRecorded);
  const title = view === "sources" ? (zh ? "原始差异记录" : "Recorded comparisons") : activeArtifact?.label ?? fileName;

  const markReviewed = (): void => {
    if (!selected) return;
    const next = { ...reviewed };
    if (isReviewed(selected)) delete next[selected.id]; else next[selected.id] = selected.revision;
    setReviewed(next);
    try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(Object.entries(next).slice(-512)))); } catch { /* Keep the mark for this open view. */ }
  };
  const chooseFile = (index: number): void => { if (editor?.saving) return; setView("diff"); onSelect(index); };
  const navigateFile = (direction: -1 | 1): void => {
    const current = visible.findIndex(file => file.index === selectedIndex);
    const next = visible[(current + direction + visible.length) % visible.length];
    if (next) chooseFile(next.index);
  };

  return <div className="change-review" data-design-frame="E9PK5FVQR-" aria-label={zh ? "文件更改" : "File changes"}>
    <nav className="review-files" aria-label={zh ? "更改文件" : "Changed files"}>
      <div className="review-files-heading"><h2>{zh ? "文件更改" : "File changes"}<span>{files.length}</span></h2>
        <div className="review-menu-anchor" ref={fileMenuRef}><button type="button" className="review-icon-button" title={zh ? "文件操作" : "File actions"} aria-label={zh ? "文件操作" : "File actions"} aria-haspopup="menu" aria-expanded={menuOpen === "files"} onClick={() => setMenuOpen(value => value === "files" ? null : "files")}><MoreHorizontal size={16}/></button>
          {menuOpen === "files" && <div className="review-menu" role="menu">
            <button type="button" role="menuitem" disabled={!visible.length || !!editor} onClick={() => { navigateFile(-1); setMenuOpen(null); }}><ChevronLeft size={14}/>{zh ? "上一个文件" : "Previous file"}</button>
            <button type="button" role="menuitem" disabled={!visible.length || !!editor} onClick={() => { navigateFile(1); setMenuOpen(null); }}><ChevronRight size={14}/>{zh ? "下一个文件" : "Next file"}</button>
            <button type="button" role="menuitem" onClick={() => { setCollapsed(new Set()); setMenuOpen(null); }}><Folder size={14}/>{zh ? "展开所有目录" : "Expand all folders"}</button>
            <button type="button" role="menuitem" onClick={() => { setCollapsed(new Set(directories.keys())); setMenuOpen(null); }}><Folder size={14}/>{zh ? "折叠所有目录" : "Collapse all folders"}</button>
          </div>}
        </div>
      </div>
      <div className="review-file-summary">{hasCounts && <><span className="review-added">+{totals.added}</span><span className="review-removed">−{totals.removed}</span></>}</div>
      <label className="review-search"><Search size={14} aria-hidden/><input aria-label={zh ? "筛选文件" : "Filter files"} placeholder={zh ? "筛选文件" : "Filter files"} value={query} onChange={event => setQuery(event.target.value)}/>{query && <button type="button" aria-label={zh ? "清空筛选" : "Clear filter"} onClick={() => setQuery("")}><X size={13}/></button>}</label>
      <div className="review-file-filters" role="group" aria-label={zh ? "文件筛选" : "File filters"}>
        <button type="button" aria-pressed={filter === "all" && view === "diff"} onClick={() => { setFilter("all"); setView("diff"); }}>{zh ? "全部" : "All"}</button>
        <button type="button" aria-pressed={filter === "unread" && view === "diff"} onClick={() => { setFilter("unread"); setView("diff"); }}>{zh ? "未查看" : "Unreviewed"}<span>{files.length - readCount}</span></button>
        {tests && <button type="button" aria-pressed={view === "test_report"} onClick={() => setView("test_report")}>{zh ? "测试" : "Tests"}<span>{tests.items.length}</span></button>}
      </div>
      <div className="review-file-tree">
        {[...directories].map(([key, group]) => <section key={key}>
          {group.label && <button type="button" className="review-directory" aria-expanded={!collapsed.has(key)} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; })}><ChevronDown size={12} className={collapsed.has(key) ? "is-collapsed" : ""}/><Folder size={12}/><span title={group.label}>{group.label.replace(/\//g, " / ")}</span></button>}
          {!collapsed.has(key) && group.files.map(file => <button type="button" key={file.id} className={`review-file${file.index === selectedIndex && view === "diff" ? " is-current" : ""}`} aria-current={file.index === selectedIndex && view === "diff" ? "true" : undefined} disabled={!!editor && file.index !== selectedIndex} title={file.entry.path} onClick={() => chooseFile(file.index)}>
            <FileTypeIcon path={file.entry.path}/><span className="review-file-name">{file.name}</span>
            {isReviewed(file) ? <Check size={12} className="review-file-check" aria-label={zh ? "已查看" : "Reviewed"}/> : countsFor(file) && !!(countsFor(file)!.additions || countsFor(file)!.deletions) ? <span className="review-file-delta"><span>+{countsFor(file)!.additions}</span><span>−{countsFor(file)!.deletions}</span></span> : null}
          </button>)}
        </section>)}
        {!visible.length && <p className="review-no-matches">{query ? (zh ? "没有匹配的文件" : "No matching files") : filter === "unread" && files.length ? (zh ? "全部已查看" : "All files reviewed") : (zh ? "还没有文件更改" : "No file changes yet")}</p>}
      </div>
      <div className="review-file-progress"><span><Check size={12}/>{zh ? "已查看" : "Reviewed"} {readCount} / {files.length}</span><div role="progressbar" aria-label={zh ? "审阅进度" : "Review progress"} aria-valuemin={0} aria-valuemax={Math.max(1, files.length)} aria-valuenow={readCount}><i style={{ width: `${files.length ? readCount / files.length * 100 : 0}%` }}/></div></div>
    </nav>
    <main className="review-main">
      <header className="review-main-heading">
        <div className="review-document">{view === "diff" && selected ? <FileTypeIcon path={selected.entry.path} size={20}/> : <FileCode2 size={20}/>}<div><h3 title={title}>{title}</h3>{view === "diff" && selected?.directory && <p title={selected.entry.path}>{selected.directory.replace(/\//g, " / ")}</p>}</div></div>
        <div className="review-toolbar">
          {editor ? <div className="review-edit-actions"><button type="button" onClick={onCancelEdit} disabled={editor.saving}>{zh ? "取消" : "Cancel"}</button><button type="button" className="review-save" disabled={editor.saving || editor.value.replace(/\r\n/g, "\n") === editor.original.replace(/\r\n/g, "\n")} onClick={onSaveEdit}>{editor.saving ? <Loader2 size={13} className="animate-spin"/> : <Check size={13}/>} {zh ? "保存" : "Save"}</button></div> : null}
          {view === "diff" && <div className="review-view-switch" role="group" aria-label={zh ? "对比视图" : "Diff view"}><button type="button" aria-pressed={!split} onClick={() => setMode("unified")}><List size={14}/>{before === undefined && preview ? (zh ? "完整文件" : "Full file") : (zh ? "合并" : "Unified")}</button><button type="button" disabled={!!preview && before === undefined} title={preview && before === undefined ? (zh ? "未记录修改前的完整版本，当前显示完整文件" : "Historical baseline unavailable; showing the full current file") : undefined} aria-pressed={split} onClick={() => setMode("split")}><Columns2 size={14}/>{zh ? "并排" : "Split"}</button></div>}
          <div className="review-menu-anchor" ref={menuRef}><button type="button" className="review-icon-button" title={zh ? "更多操作" : "More actions"} aria-label={zh ? "更多操作" : "More actions"} aria-haspopup="menu" aria-expanded={menuOpen === "editor"} disabled={!sourceCount && !artifactTabs.length && (!selected || !!editor)} onClick={() => setMenuOpen(value => value === "editor" ? null : "editor")}><MoreHorizontal size={17}/></button>
            {menuOpen === "editor" && <div className="review-menu" role="menu" onKeyDown={event => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault(); const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]; const current = items.indexOf(document.activeElement as HTMLButtonElement); items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
            }}>
              {selected && !editor && <><button type="button" role="menuitem" disabled={editLoading} onClick={() => { setMenuOpen(null); onEdit(selected.entry); }}>{editLoading ? <Loader2 size={14}/> : <Pencil size={14}/>} {zh ? "编辑文件" : "Edit file"}</button><button type="button" role="menuitem" disabled={reverting || (selected.entry.kind === "patch" && (selected.entry.comparisonUnavailable || selected.entry.changeType === "deleted"))} onClick={() => { if (revertArmed) setMenuOpen(null); onRevert(selected.entry); }}><RotateCcw size={14}/>{revertArmed ? (zh ? "确认撤销此文件改动" : "Confirm revert") : (zh ? "撤销此文件改动" : "Revert file changes")}</button></>}
              {view !== "diff" && <button type="button" role="menuitem" onClick={() => { setView("diff"); setMenuOpen(null); }}><FileCode2 size={14}/>{zh ? "文件更改" : "File changes"}</button>}
              {selected && view !== "records" && <button type="button" role="menuitem" onClick={() => { setView("records"); setMenuOpen(null); }}><History size={14}/>{zh ? "查看修改记录" : "Recorded edits"}</button>}
              {!!sourceCount && <button type="button" role="menuitem" onClick={() => { setView("sources"); setMenuOpen(null); }}><History size={14}/>{zh ? "原始差异记录" : "Recorded comparisons"}<span>{sourceCount}</span></button>}
              {artifactTabs.map(tab => <button type="button" role="menuitem" key={tab.id} onClick={() => { setView(tab.id); setMenuOpen(null); }}><FileCode2 size={14}/>{tab.label}<span>{tab.items.length}</span></button>)}
            </div>}
          </div>
          <button type="button" className="review-icon-button" disabled={editor?.saving} onClick={onClose} title={zh ? "关闭审阅" : "Close review"} aria-label={zh ? "关闭审阅" : "Close review"}><X size={16}/></button>
        </div>
      </header>
      <section className="review-code-workspace" aria-label={title}>
        {view === "diff" ? <>
          <div className={`review-version-titles${!split ? " is-unified" : ""}`}>
            {split && <span><History size={14}/>{zh ? "修改前" : "Before"}</span>}
            <span className="review-version-after"><i/>{showRecorded ? (zh ? "已记录的改动" : "Recorded changes") : before === undefined && canCompare ? (zh ? "当前文件" : "Current file") : !split ? (zh ? "文件改动" : "Changes") : (zh ? "修改后" : "After")}<span className="review-version-stats">{selectedCounts && (before !== undefined || showRecorded) && <><b>+{selectedCounts.additions}</b><em>−{selectedCounts.deletions}</em></>}</span></span>
          </div>
          {loading && !editor ? <div className="review-loading" role="status"><Loader2 size={17} className="animate-spin"/>{zh ? "读取文件…" : "Loading file…"}</div> : canCompare ? <>
            {preview?.truncated && <p className="review-recorded-notice" role="status">{zh ? "文件超过 2 MB，当前预览已截断" : "The file exceeds 2 MB; this preview is truncated"}</p>}
            {preview?.recorded && <p className="review-recorded-notice" role="status">{zh ? "当前文件已不存在，显示已保存的改动版本" : "The current file no longer exists; showing the saved change versions"}</p>}
            <Suspense fallback={<div className="review-loading" role="status"><Loader2 size={17} className="animate-spin"/>{zh ? "加载代码…" : "Loading editor…"}</div>}>
              <DiffCodeEditor key={`${editor?.resolvedPath ?? preview?.path}:${before === undefined ? "single" : "diff"}`} before={before} value={after!} filePath={editor?.resolvedPath ?? preview?.path} appearance="review" readOnly={!editor} sideBySide={split} onChange={onEditorChange} navigationRef={navigationRef} onReviewPosition={setPosition}/>
            </Suspense>
          </> : showRecorded && selected ? <div className="review-recorded"><p className="review-recorded-notice" role="status">{readError} · {zh ? "显示已保存的差异记录" : "Showing saved changes"}</p><RecordedChangeReview key={snapshotKey} entry={selected.entry} sideBySide={mode === "split"} navigationRef={navigationRef} onReviewPosition={setPosition}/></div> : selected ? <div className="review-empty" role="status"><FileCode2 size={27}/><p>{readError || (zh ? "文件暂不可用" : "File unavailable")}</p><button type="button" onClick={() => setReload(value => value + 1)}><RotateCcw size={13}/>{zh ? "重新读取" : "Retry"}</button></div> : <div className="review-empty"><FileCode2 size={27}/><p>{comparisonUnavailable ? (zh ? "没有可读取的差异详情" : "No readable diff details") : (zh ? "还没有文件更改" : "No file changes yet")}</p>{!!sourceCount && <button type="button" onClick={() => setView("sources")}>{zh ? "查看原始差异记录" : "View recorded comparisons"}<ChevronRight size={13}/></button>}</div>}
          <footer className="review-code-footer">{before === undefined && !showRecorded ? <span>{after === undefined ? "" : zh ? `共 ${after.split(/\r?\n/).length} 行` : `${after.split(/\r?\n/).length} lines`}</span> : <div className="review-change-paging"><button type="button" disabled={!position.count} onClick={() => navigationRef.current?.move(-1)} title={zh ? "上一处改动" : "Previous change"} aria-label={zh ? "上一处改动" : "Previous change"}><ChevronLeft size={13}/></button><span>{position.count ? (zh ? `第 ${position.index} / ${position.count} 处改动` : `${position.index} / ${position.count} changes`) : (zh ? "无净改动" : "No net changes")}</span><button type="button" disabled={!position.count} onClick={() => navigationRef.current?.move(1)} title={zh ? "下一处改动" : "Next change"} aria-label={zh ? "下一处改动" : "Next change"}><ChevronRight size={13}/></button></div>}
            <button type="button" className="review-mark-read" disabled={!selected || loading || !!editor || !canCompare && !showRecorded} aria-pressed={selected ? isReviewed(selected) : false} onClick={markReviewed}><Check size={13}/>{selected && isReviewed(selected) ? (zh ? "已查看" : "Reviewed") : (zh ? "标记已查看" : "Mark as reviewed")}</button>
          </footer>
        </> : view === "records" && selected ? <div className="review-recorded"><RecordedChangeReview key={snapshotKey} entry={selected.entry} sideBySide={mode === "split"} navigationRef={navigationRef} onReviewPosition={setPosition}/></div> : view === "sources" ? <div className="review-source-records">{sourceContent}</div> : <div className="review-artifact-records">{activeArtifact?.items.map(artifact => <section key={artifact.id}><h4>{artifact.name}</h4><pre>{artifact.content}</pre></section>)}</div>}
      </section>
    </main>
  </div>;
}
