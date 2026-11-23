import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ExternalLink, FileWarning, FolderOpen, ListTree,
  Maximize2, Minimize2, MoreHorizontal, RefreshCw, Search, WrapText, X
} from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { requestCore } from "../../lib/bridge";
import { recordedFileVersions, reviewBefore, reviewLineCounts, reviewRelativePath } from "../../lib/change-review";
import { reverseApplyUnifiedPatch } from "../../lib/revert-change";
import { normalizeLocalFilePath } from "../../lib/file-references";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { collectChangedFiles } from "../../lib/changed-files";
import { base64ToBytes, normalizePathKey, OFFICE_KINDS, resolvePreview, type PreviewErrorReason, type WorkPreviewKind } from "../../lib/work-preview";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { MarkdownContent } from "../timeline/MarkdownContent";
import { openFileWithToast } from "../timeline/media-actions";
import type { PreviewFileRequest } from "../sessions/WorkspacePreview";
import { SourceControlDiffView } from "../sessions/SourceControlDiffView";
import type { DiffReviewNavigation, DiffReviewPosition } from "../../components/ui/DiffCodeEditor";
import { DocumentPreview } from "./preview/DocumentPreview";
import { PreviewCopyButton } from "./preview/PreviewCopyButton";
import { PreviewTabBar } from "./preview/PreviewTabBar";
import { DelimitedFilePreview, ImageFilePreview } from "./preview/PreviewMedia";
import type { PreviewNavState, PreviewZoom } from "./preview/types";
import type { PreviewEditorHandle, PreviewLines } from "./preview/TextFilePreview";

const Code = lazy(() => import("./preview/TextFilePreview").then(module => ({ default: module.TextFilePreview })));
const Diff = lazy(() => import("../../components/ui/DiffCodeEditor"));
const visibleBytes = 2 * 1024 * 1024;
const visibleLines = 10_000;

interface FileSnapshot {
  key: string;
  kind: WorkPreviewKind;
  size: number;
  mime: string;
  modifiedAt: string;
  encoding?: string;
  totalLines?: number;
  text?: string;
  limited?: boolean;
  bytes?: Uint8Array;
  url?: string;
}

function decodeFile(bytes: Uint8Array, prefixOnly: boolean): { text: string; encoding: string } {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  return { text: new TextDecoder(encoding).decode(bytes, { stream: prefixOnly }), encoding: encoding.toUpperCase() };
}

function textWindow(text: string, prefixOnly: boolean, force: boolean): { text: string; totalLines?: number; limited: boolean } {
  let totalLines = text.length ? 1 : 0;
  let end = text.length;
  const breaks = /\r\n|\r|\n/g;
  for (let next = breaks.exec(text); next; next = breaks.exec(text)) {
    if (totalLines === visibleLines) end = next.index;
    totalLines += 1;
  }
  const limited = !force && (totalLines > visibleLines || prefixOnly);
  return { text: limited ? text.slice(0, end) : text, totalLines: prefixOnly ? undefined : totalLines, limited };
}

export function WorkPreviewPane({ sessionId, request, onClose, wide, onToggleWide, onQuote }: {
  sessionId: string;
  request: PreviewFileRequest;
  onClose(): void;
  wide: boolean;
  onToggleWide(): void;
  onQuote(reference: string): void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const reduced = useUiReducedMotion();
  const events = useSessionsStore(state => state.events[sessionId]);
  const session = useSessionsStore(state => state.sessions.find(item => item.id === sessionId));
  const project = useProjectsStore(state => state.projects.find(item => item.id === session?.projectId));
  const changes = useMemo(() => collectChangedFiles(events ?? []), [events]);
  const relativePath = useCallback((path: string): string => reviewRelativePath(normalizeLocalFilePath(path), project?.rootPath).replace(/^(?:\.\/)+/, ""), [project?.rootPath]);
  const [selection, select] = useState<string>();
  const [tabs, setTabs] = useState<string[]>([]);
  const [view, setView] = useState<"preview" | "source" | "diff" | "update">("preview");
  const [location, setLocation] = useState<{ path: string; line: number }>();
  const noteArrival = useCallback((path: string): void => {
    const relative = relativePath(path);
    const key = normalizePathKey(relative);
    const line = path.match(/(?::|#L)(\d+)(?:-L?\d+)?$/i);
    setLocation(line && relative !== path ? { path: relative, line: Number(line[1]) } : undefined);
    setTabs(current => current.some(tab => normalizePathKey(tab) === key) ? current : [...current, relative]);
    select(key);
  }, [relativePath]);
  useLayoutEffect(() => { noteArrival(request.path); setView(request.diff ? "diff" : "preview"); }, [request, noteArrival]);
  const activePath = tabs.find(path => normalizePathKey(path) === selection) ?? tabs[0];
  function closeTabs(paths: string[]): void {
    setTabs(current => current.filter(path => !paths.includes(path)));
    if (activePath && paths.includes(activePath)) {
      const index = tabs.indexOf(activePath);
      const neighbor = tabs.slice(index + 1).find(path => !paths.includes(path)) ?? tabs.slice(0, index).reverse().find(path => !paths.includes(path));
      select(neighbor ? normalizePathKey(neighbor) : undefined);
      setLocation(undefined);
      setView("preview");
    }
  }

  const fileKey = activePath && project ? project.id + ":" + activePath : "";
  const absolutePath = (path: string): string => project && !/^(?:[A-Za-z]:\/|\/)/.test(path)
    ? project.rootPath.replace(/\\/g, "/").replace(/\/$/, "") + "/" + path : path;
  const fullPath = activePath && absolutePath(activePath);
  const shell = window.agenthub?.shell;
  const entry = changes.find(item => normalizePathKey(relativePath(item.path)) === selection
    || activePath !== undefined && normalizePathKey(relativePath(item.path)) === normalizePathKey(activePath));
  const requestPatch = activePath && normalizePathKey(relativePath(request.path)) === normalizePathKey(activePath) ? request.diff : undefined;
  const patch = requestPatch ?? (entry?.kind === "patch" ? entry.diff : undefined);
  const recorded = entry?.kind === "fileDiff" && !entry.diff.truncated ? entry.diff : undefined;
  const touch = entry?.edits;
  const lastChange = entry?.kind === "patch" ? entry.diff : entry?.diff.after;
  const syncing = !!session && ["running", "waiting_approval", "waiting_input"].includes(session.status);

  const [snapshot, setSnapshot] = useState<FileSnapshot>();
  const latest = useRef<FileSnapshot>();
  const [error, setError] = useState<{ key: string; message: string }>();
  const [reload, setReload] = useState(0);
  const [forceKey, setForceKey] = useState<string>();
  const [update, setUpdate] = useState<{ key: string; before?: string }>();
  const file = snapshot?.key === fileKey ? snapshot : undefined;
  const failure = error?.key === fileKey ? error.message : undefined;
  const recent = update?.key === fileKey ? update : undefined;
  const force = forceKey === fileKey;

  useEffect(() => {
    if (!activePath || !project) return;
    let cancelled = false;
    let reading = false;
    async function read(): Promise<void> {
      if (reading) return;
      reading = true;
      try {
        const result = await requestCore<{ base64: string; mimeType: string; size: number; modifiedAt: string }>(
          "artifact.read", { projectId: project!.id, path: activePath }
        );
        if (cancelled) return;
        setError(undefined);
        const previous = latest.current?.key === fileKey ? latest.current : undefined;
        const kind = resolvePreview(activePath!, result.mimeType);
        const svg = kind === "image" && /\.svg$/i.test(activePath!);
        const textKind = svg || ["markdown", "csv", "text", "html"].includes(kind);
        if (previous?.modifiedAt === result.modifiedAt && previous.size === result.size
          && (!textKind || previous.limited === false || !force)) return;
        const next: FileSnapshot = { key: fileKey, kind, size: result.size, mime: result.mimeType, modifiedAt: result.modifiedAt };
        if (textKind || kind === "image" || OFFICE_KINDS.includes(kind)) {
          const prefixOnly = textKind && result.size > visibleBytes && !force;
          const bytes = base64ToBytes(prefixOnly && !svg ? result.base64.slice(0, Math.floor(visibleBytes / 3) * 4) : result.base64);
          if (textKind) {
            const decoded = decodeFile(prefixOnly ? bytes.subarray(0, visibleBytes) : bytes, prefixOnly);
            Object.assign(next, textWindow(decoded.text, prefixOnly, force), { encoding: decoded.encoding });
          }
          if (kind === "image") next.url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: result.mimeType }));
          if (OFFICE_KINDS.includes(kind)) next.bytes = bytes;
        }
        if (previous && (previous.modifiedAt !== next.modifiedAt || previous.size !== next.size)) {
          setUpdate({ key: fileKey, before: previous.limited ? undefined : previous.text });
        }
        latest.current = next;
        setSnapshot(next);
      } catch (cause) {
        if (cancelled) return;
        latest.current = undefined;
        setSnapshot(undefined);
        setError({ key: fileKey, message: cause instanceof Error ? cause.message : String(cause) });
      } finally {
        reading = false;
      }
    }
    void read();
    const timer = syncing ? window.setInterval(() => { if (!document.hidden) void read(); }, 4000) : undefined;
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activePath, project, fileKey, touch, lastChange, reload, force, syncing]);
  useEffect(() => {
    const url = snapshot?.url;
    if (url) return () => URL.revokeObjectURL(url);
  }, [snapshot?.url]);

  const text = file?.text;
  const markdown = file?.kind === "markdown";
  const svg = file?.kind === "image" && text !== undefined;
  const tabular = file?.kind === "csv";
  const modes = markdown || svg || tabular;
  const deleted = failure && entry?.kind === "patch" && entry.changeType === "deleted" ? recordedFileVersions(entry) : undefined;
  const canDiff = !!(patch || recorded || recent?.before !== undefined || deleted);
  const showDiff = (view === "diff" || view === "update") && canDiff;
  const source = view === "source" || file?.kind === "text" || location?.path === activePath && !!location;
  const renderMarkdown = markdown && !source && !showDiff;
  const showCode = !showDiff && text !== undefined && (source || file?.kind === "html" && file.limited);
  const editor = useRef<PreviewEditorHandle | null>(null);
  const [wrap, setWrap] = useState(false);
  const [font, setFont] = useState(13);
  const [lines, setLines] = useState<PreviewLines>();
  const [outline, setOutline] = useState<HTMLElement[]>();
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [heading, setHeading] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const progress = useRef<HTMLSpanElement>(null);
  const [nav, setNav] = useState<PreviewNavState | null>(null);
  const [zoom, setZoom] = useState<PreviewZoom>("fit-width");
  const [officeError, setOfficeError] = useState<string>();
  const office = !!file?.bytes;
  const handleReady = useCallback(() => {}, []);
  const handleError = useCallback((message: string, _reason: PreviewErrorReason) => setOfficeError(message), []);
  const diffNav = useRef<DiffReviewNavigation | null>(null);
  const [diffPosition, setDiffPosition] = useState<DiffReviewPosition>({ index: 0, count: 0 });
  const patchIndex = useRef(0);

  useLayoutEffect(() => {
    setOutline(undefined); setOutlineOpen(false); setHeading(0);
    setNav(null); setZoom("fit-width"); setOfficeError(undefined);
  }, [fileKey]);
  useLayoutEffect(() => {
    setOutlineOpen(false);
    if (progress.current) progress.current.style.transform = "scaleX(0)";
  }, [source, showDiff]);
  useLayoutEffect(() => {
    patchIndex.current = 0;
    setDiffPosition({ index: 0, count: 0 });
  }, [fileKey, showDiff]);
  const updateOutline = useCallback(() => {
    const headings = Array.from(body.current?.querySelectorAll<HTMLElement>(".preview-document [data-markdown-formatted]:not([hidden]) :is(h1,h2,h3)") ?? []);
    setOutline(current => current?.length === headings.length && current.every((node, index) => node === headings[index]) ? current : headings);
  }, []);
  const moveToLine = useCallback((instance: PreviewEditorHandle | null) => {
    editor.current = instance;
    if (location?.path === activePath && instance) instance.reveal(location.line);
  }, [location, activePath]);
  function onFind(): void {
    if (showCode) editor.current?.find();
    else diffNav.current?.find?.();
  }

  const diffFiles = useMemo(() => {
    if (!showDiff) return undefined;
    if (deleted) return deleted;
    if (!file?.limited && text !== undefined) {
      if (view === "update" && recent?.before !== undefined) return { before: recent.before, after: text };
      if (requestPatch) {
        const result = reverseApplyUnifiedPatch(text, requestPatch);
        if (result.ok) return { before: result.content, after: text };
      } else if (entry) {
        const before = reviewBefore(entry, text);
        if (before !== undefined) return { before, after: text };
      }
      if (!patch && !recorded && recent?.before !== undefined) return { before: recent.before, after: text };
    }
    return recorded ? { before: recorded.before, after: recorded.after } : undefined;
  }, [showDiff, view, deleted, recent, file?.limited, requestPatch, patch, entry, recorded, text]);
  const diffCounts = useMemo(() => diffFiles ? reviewLineCounts(diffFiles.before, diffFiles.after)
    : patch ? {
      additions: (patch.match(/^\+(?!\+\+)/gm) ?? []).length,
      deletions: (patch.match(/^-(?!--)/gm) ?? []).length
    } : undefined, [diffFiles, patch]);
  const hunks = useMemo(() => patch?.split("\n").flatMap((line, index) => line.startsWith("@@ ") ? [index] : []) ?? [], [patch]);
  const moveChange = useCallback((direction: -1 | 1) => {
    if (diffNav.current) { diffNav.current.move(direction); return; }
    if (!hunks.length) return;
    patchIndex.current = (patchIndex.current + direction + hunks.length) % hunks.length;
    body.current?.querySelector(".scm-diff-code")?.scrollTo({ top: hunks[patchIndex.current]! * 20, behavior: reduced ? "instant" : "smooth" });
    setDiffPosition({ index: patchIndex.current + 1, count: hunks.length });
  }, [hunks, reduced]);
  useEffect(() => {
    if (!showDiff || diffFiles || !hunks.length) return;
    patchIndex.current = hunks.length - 1;
    const frame = requestAnimationFrame(() => moveChange(1));
    return () => cancelAnimationFrame(frame);
  }, [showDiff, diffFiles, hunks, moveChange]);

  const openExternal = (): void => { if (fullPath) void openFileWithToast(fullPath, t); };
  const reveal = (): void => { if (fullPath) void shell?.showItemInFolder(fullPath); };
  const localOpen = !!fullPath && !!shell?.openPath;
  const localReveal = !!fullPath && !!shell?.showItemInFolder;
  const filename = activePath?.split("/").at(-1);
  const type = activePath?.match(/\.([^./]+)$/)?.[1]?.toUpperCase() ?? file?.mime;
  const displaySize = file ? file.size < 1024 ? file.size + " B" : (file.size / 1024).toFixed(1) + " KB" : undefined;
  const findLabel = zh ? "搜索文件 (Ctrl+F / ⌘F)" : "Find in file (Ctrl+F / ⌘F)";
  const shortcut = (key: string): string => (/Mac/.test(navigator.platform) ? "⌘⌥" : "Ctrl+Alt+") + key;
  const copyLabel = file?.limited ? zh ? "复制当前预览" : "Copy preview" : zh ? "复制内容" : "Copy content";
  const wrapLabel = zh ? "自动换行" : "Word wrap";
  const outlineLabel = zh ? "目录大纲" : "Outline";
  const status = showDiff ? "Diff" : syncing ? zh ? "实时同步中" : "Live sync" : zh ? "只读预览" : "Read-only";
  const currentChange = diffPosition.count ? diffPosition.index + " / " + diffPosition.count : undefined;
  const unavailable = file?.kind === "binary" || file?.kind === "legacy-office";
  const noContent = file?.size === 0;
  const infoTitle = noContent ? zh ? "空文件" : "Empty file"
    : unavailable ? zh ? "系统应用可打开此文件" : "Open this file with a system app"
    : !activePath ? zh ? "没有打开的文件" : "No open files"
    : failure && /preview limit|20\s*MB/i.test(failure) ? zh ? "文件超出预览上限" : "File exceeds the preview limit"
    : failure && /not found|不存在|找不到/i.test(failure) ? zh ? "文件不存在或已删除" : "File is missing or was deleted"
    : zh ? "无法预览文件" : "Unable to preview file";

  return <div className="preview-pane" onKeyDownCapture={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && (showCode || diffNav.current?.find)) {
      event.preventDefault(); event.stopPropagation(); onFind();
    } else if ((event.ctrlKey || event.metaKey) && event.altKey && !event.getModifierState("AltGraph")) {
      const actions: Record<string, (() => void) | undefined> = {
        KeyZ: showCode ? () => setWrap(!wrap) : undefined,
        KeyV: modes ? () => { setLocation(undefined); setView(source && !showDiff ? "preview" : "source"); } : undefined,
        KeyD: canDiff ? () => setView(showDiff ? "preview" : "diff") : undefined,
        KeyC: text !== undefined ? () => void navigator.clipboard.writeText(text) : undefined,
        KeyO: localOpen ? openExternal : undefined,
        KeyE: localReveal ? reveal : undefined,
        KeyM: onToggleWide
      };
      const action = actions[event.code];
      if (action) { event.preventDefault(); event.stopPropagation(); action(); }
    } else if (event.key === "Escape" && outlineOpen) {
      event.stopPropagation();
      setOutlineOpen(false);
    }
  }}>
    <header className="preview-header">
      <PreviewTabBar tabs={tabs} active={activePath} resolvePath={absolutePath} onSelect={path => { noteArrival(path); setView("preview"); }}
        onCloseTabs={closeTabs} pathControl={fullPath && <PreviewCopyButton key={fullPath} value={fullPath} label={t("sessions.media.copyPath")}>
          {tabs.length === 1 && activePath?.includes("/") ? <span className="preview-directory">{activePath.slice(0, activePath.lastIndexOf("/"))}</span> : undefined}
        </PreviewCopyButton>} />
      <div className="preview-actions">
        {(modes || canDiff) && <div className="preview-group preview-view-group">
          {modes && !showDiff && <>
            <ToolbarButton label={tabular ? zh ? "表格" : "Table" : zh ? "预览" : "Preview"} pressed={!source} shortcut={shortcut("V")}
              onClick={() => { setLocation(undefined); setView("preview"); }}>{tabular ? zh ? "表格" : "Table" : zh ? "预览" : "Preview"}</ToolbarButton>
            <ToolbarButton label={zh ? "源码" : "Source"} pressed={source} shortcut={shortcut("V")} onClick={() => setView("source")}>{zh ? "源码" : "Source"}</ToolbarButton>
          </>}
          {canDiff && <>
            <ToolbarButton label={zh ? "全文" : "Full file"} pressed={!showDiff} shortcut={shortcut("D")} onClick={() => setView("preview")}>{zh ? "全文" : "File"}</ToolbarButton>
            <ToolbarButton label={zh ? "查看改动" : "View changes"} pressed={showDiff} shortcut={shortcut("D")} onClick={() => setView("diff")}>Diff</ToolbarButton>
          </>}
        </div>}
        {activePath && <div className="preview-group preview-common">
          {(showCode || diffFiles) && <ToolbarButton label={findLabel} onClick={onFind}><Search size={15}/></ToolbarButton>}
          {showCode && <ToolbarButton label={wrapLabel} pressed={wrap} shortcut={shortcut("Z")} onClick={() => setWrap(!wrap)}><WrapText size={15}/></ToolbarButton>}
          {renderMarkdown && !!outline?.length && <ToolbarButton label={outlineLabel} pressed={outlineOpen} onClick={() => setOutlineOpen(!outlineOpen)}><ListTree size={15}/></ToolbarButton>}
          {text !== undefined && <PreviewCopyButton key={fileKey} value={text} label={copyLabel} shortcut={shortcut("C")} />}
          {localOpen && <ToolbarButton label={t("work.preview.openExternal")} shortcut={shortcut("O")} onClick={openExternal}><ExternalLink size={14}/></ToolbarButton>}
          {localReveal && <ToolbarButton label={t("sessions.filePreview.showInFolder")} shortcut={shortcut("E")} onClick={reveal}><FolderOpen size={15}/></ToolbarButton>}
          <ToolbarButton label={t("work.preview.reload")} onClick={() => setReload(value => value + 1)}><RefreshCw size={14}/></ToolbarButton>
        </div>}
        {activePath && <Menu.Root>
          <Menu.Trigger asChild><button type="button" className="preview-tool preview-more" aria-label={zh ? "文件操作" : "File actions"} title={zh ? "文件操作" : "File actions"}><MoreHorizontal size={15}/></button></Menu.Trigger>
          <Menu.Portal><Menu.Content className="preview-menu" align="end" sideOffset={6}>
            {fullPath && <Menu.Item onSelect={() => void navigator.clipboard.writeText(fullPath)}>{zh ? "复制路径" : "Copy path"}</Menu.Item>}
            {text !== undefined && <Menu.Item onSelect={() => void navigator.clipboard.writeText(text)}>{copyLabel}</Menu.Item>}
            {(showCode || diffFiles) && <Menu.Item onSelect={() => requestAnimationFrame(onFind)}>{findLabel}</Menu.Item>}
            {showCode && <Menu.Item onSelect={() => setWrap(!wrap)}>{wrapLabel}</Menu.Item>}
            {renderMarkdown && !!outline?.length && <Menu.Item onSelect={() => setOutlineOpen(!outlineOpen)}>{outlineLabel}</Menu.Item>}
            {modes && <Menu.Item onSelect={() => { setLocation(undefined); setView(source ? "preview" : "source"); }}>{source ? zh ? "预览" : "Preview" : zh ? "源码" : "Source"}</Menu.Item>}
            {canDiff && <Menu.Item onSelect={() => setView(showDiff ? "preview" : "diff")}>{showDiff ? zh ? "全文" : "Full file" : "Diff"}</Menu.Item>}
            {localOpen && <Menu.Item onSelect={openExternal}>{t("work.preview.openExternal")}</Menu.Item>}
            {localReveal && <Menu.Item onSelect={reveal}>{t("sessions.filePreview.showInFolder")}</Menu.Item>}
            <Menu.Item onSelect={() => setReload(value => value + 1)}>{t("work.preview.reload")}</Menu.Item>
          </Menu.Content></Menu.Portal>
        </Menu.Root>}
        <div className="preview-group">
          <ToolbarButton label={wide ? zh ? "还原宽度" : "Restore width" : zh ? "宽屏展开" : "Expand preview"}
            pressed={wide} shortcut={shortcut("M")} onClick={onToggleWide}>{wide ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}</ToolbarButton>
          <button type="button" className="preview-tool" onClick={onClose} title={zh ? "关闭预览 (Esc)" : "Close preview (Esc)"}
            aria-label={zh ? "关闭预览" : "Close preview"}><X size={16}/></button>
        </div>
      </div>
      <span ref={progress} className="preview-read-progress" aria-hidden />
    </header>

    <div className="preview-pane-body" ref={body} onScrollCapture={event => {
      const node = event.target;
      if (!(node instanceof HTMLElement) || !node.classList.contains("preview-document-scroll")) return;
      const distance = node.scrollHeight - node.clientHeight;
      if (progress.current) progress.current.style.transform = "scaleX(" + (distance > 0 ? node.scrollTop / distance : 0) + ")";
      const top = node.getBoundingClientRect().top + 42;
      if (outline?.length) {
        let high = outline.length - 1;
        let low = node.scrollTop >= distance - 2 ? high : 0;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (outline[middle]!.getBoundingClientRect().top <= top) low = middle;
          else high = middle - 1;
        }
        setHeading(low);
      }
    }}>
      {recent && !showDiff && <div role="status" className="preview-notice preview-update"><span>{zh ? "文件已更新" : "File updated"}</span>
        {canDiff && <button type="button" onClick={() => setView("update")}>{zh ? "查看改动" : "View changes"}</button>}
        <ToolbarButton label={zh ? "关闭更新提示" : "Dismiss update"} onClick={() => setUpdate(undefined)}><X size={13}/></ToolbarButton>
      </div>}
      {file?.limited && <div className="preview-notice">
        <span>{zh ? "已截断大型文件预览" : "Preview truncated for a large file"}</span>
        <button type="button" onClick={() => setForceKey(fileKey)}>{zh ? "强制加载全文" : "Load full file"}</button>
        {localOpen && <button type="button" onClick={openExternal}>{zh ? "本地打开" : "Open locally"}</button>}
      </div>}
      {showDiff && <div className="preview-diff-card">
        <div className="preview-diff-summary">
          <strong>Diff</strong>
          {diffCounts && <span className="preview-pill"><span className="text-ok">+{diffCounts.additions}</span><span className="text-danger">−{diffCounts.deletions}</span></span>}
          {currentChange && <span className="preview-metadata">{currentChange}</span>}
          <div className="preview-group">
            <ToolbarButton label={zh ? "上一处改动" : "Previous change"} disabled={!diffPosition.count} onClick={() => moveChange(-1)}><ChevronUp size={14}/></ToolbarButton>
            <ToolbarButton label={zh ? "下一处改动" : "Next change"} disabled={!diffPosition.count} onClick={() => moveChange(1)}><ChevronDown size={14}/></ToolbarButton>
          </div>
        </div>
        <div className="preview-diff-content"><Suspense fallback={<PreviewSkeleton />}>
          {!file && !failure ? <PreviewSkeleton />
            : diffFiles ? <Diff before={diffFiles.before} value={diffFiles.after} filePath={activePath} modelKey={fileKey} readOnly
            sideBySide={false} appearance="review" navigationRef={diffNav} onReviewPosition={setDiffPosition}/>
            : patch && <SourceControlDiffView patch={patch} scope={fileKey} locale={locale}/>}
        </Suspense></div>
      </div>}
      {!showDiff && (activePath && !file && !failure ? <PreviewSkeleton /> :
        !activePath || failure || unavailable || noContent || officeError ? <div className="preview-info-wrap">
          <div className="preview-info-card">
            <FileWarning size={24} aria-hidden />
            <strong>{infoTitle}</strong>
            {filename && <span title={fullPath}>{filename}</span>}
            {file && <small>{[type, displaySize, unavailable ? file.mime : undefined].filter(Boolean).join(" · ")}</small>}
            {(failure || officeError) && <small>{officeError ?? failure}</small>}
            <div className="preview-info-actions">
              {localOpen && <button type="button" onClick={openExternal}>{t("work.preview.openExternal")}</button>}
              {localReveal && <button type="button" onClick={reveal}>{t("sessions.filePreview.showInFolder")}</button>}
              {(failure || officeError) && <button type="button" onClick={() => { setOfficeError(undefined); latest.current = undefined; setReload(value => value + 1); }}>{t("work.preview.retry")}</button>}
            </div>
          </div>
        </div> : <div key={fileKey + ":" + (source ? "source" : "preview")} className="preview-content-entry">
          {renderMarkdown ? <div className="preview-document-scroll"><article className="preview-document">
            <MarkdownContent source={text ?? ""} document streaming onContentLayout={updateOutline} onOpenLocalFile={path => { noteArrival(path); setView("preview"); }}
              scrollableTableLabel={zh ? "可横向滚动的表格" : "Scrollable table"}/>
          </article></div> :
          showCode ? <Suspense fallback={<PreviewSkeleton />}><Code ref={moveToLine} text={text!} path={activePath!}
            wrap={wrap} fontSize={font} zh={zh} onQuote={onQuote} onSelection={setLines}/></Suspense>
          : tabular && text !== undefined ? <DelimitedFilePreview path={activePath!} text={text}/>
          : file?.url ? <ImageFilePreview url={file.url} path={activePath!} zh={zh}/>
          : office && file?.bytes ? <div className="preview-office">
            <div className="preview-office-controls">
              {nav && <div className="preview-group">
                <ToolbarButton label={t("work.preview.prev")} disabled={nav.index <= 0} onClick={nav.prev}><ChevronLeft size={14}/></ToolbarButton>
                <input type="number" className="preview-office-index" key={nav.index} defaultValue={nav.index + 1} min={1} max={nav.count}
                  aria-label={zh ? "跳至页码" : "Go to page"} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
                  onBlur={event => { if (event.currentTarget.valueAsNumber >= 1) nav.goto(event.currentTarget.valueAsNumber - 1); }}/>
                <small className="preview-metadata">/ {nav.count}</small>
                <ToolbarButton label={t("work.preview.next")} disabled={nav.index + 1 >= nav.count} onClick={nav.next}><ChevronRight size={14}/></ToolbarButton>
              </div>}
              <div className="preview-group">
                <ToolbarButton label={t("work.preview.zoomOut")} onClick={() => setZoom(Math.max(25, (zoom === "fit-width" ? 100 : zoom) - 25))}>−</ToolbarButton>
                <ToolbarButton label={t("work.preview.fitWidth")} onClick={() => setZoom("fit-width")}>{zoom === "fit-width" ? (zh ? "适配" : "Fit") : zoom + "%"}</ToolbarButton>
                <ToolbarButton label={t("work.preview.zoomIn")} onClick={() => setZoom(Math.min(400, (zoom === "fit-width" ? 100 : zoom) + 25))}>+</ToolbarButton>
              </div>
            </div>
            <DocumentPreview key={fileKey + file.modifiedAt} path={activePath!} kind={file.kind as "pdf" | "docx" | "xlsx" | "pptx"}
              bytes={file.bytes} zoom={zoom} onNav={setNav} onReady={handleReady} onError={handleError}/>
          </div>
          : file?.kind === "html" && <iframe title={activePath} sandbox="" srcDoc={text} className="preview-html"/>}
        </div>)}
      {outlineOpen && renderMarkdown && !!outline?.length && <nav className="preview-outline" aria-label={outlineLabel}>
        {outline.map((element, index) => <button key={index} type="button" aria-current={heading === index ? "location" : undefined}
          data-level={element.tagName.slice(1)} onClick={() => {
            setHeading(index);
            element.scrollIntoView({ behavior: reduced ? "instant" : "smooth", block: "start" });
            if (!reduced) element.animate([{ backgroundColor: "var(--preview-tint)" }, { backgroundColor: "transparent" }], { duration: 600 });
          }}>{element.textContent}</button>)}
      </nav>}
    </div>
    <footer className="preview-status-bar">
      <div className="preview-status-left"><span className="preview-pill">{status}{showDiff && diffCounts && " · +" + diffCounts.additions + " −" + diffCounts.deletions}</span>
        {showCode && lines && <span>{zh ? "已选" : "Selected"} L{lines.start}{lines.end !== lines.start && "–L" + lines.end}</span>}</div>
      <div className="preview-status-right">
        <span className="preview-metadata" title={[type, displaySize, file?.encoding].filter(Boolean).join(" · ")}>
          {[type, file?.totalLines !== undefined ? file.totalLines + (zh ? " 行" : " lines") : undefined, displaySize, file?.encoding].filter(Boolean).join(" · ")}
        </span>
        {showCode && <><button type="button" aria-pressed={wrap} title={wrapLabel} onClick={() => setWrap(!wrap)}><WrapText size={13}/></button>
          <button type="button" disabled={font <= 10} onClick={() => setFont(font - 1)} title={zh ? "缩小字号" : "Decrease font size"}>A−</button>
          <button type="button" onClick={() => setFont(13)} title={zh ? "恢复默认字号" : "Reset font size"}>{font}px</button>
          <button type="button" disabled={font >= 22} onClick={() => setFont(font + 1)} title={zh ? "增大字号" : "Increase font size"}>A+</button></>}
      </div>
    </footer>
  </div>;
}

function PreviewSkeleton(): JSX.Element {
  return <div className="preview-skeleton" aria-busy="true" aria-label="Loading"><i/><i/><i/><i/><i/></div>;
}

function ToolbarButton({ label, children, onClick, pressed, disabled, shortcut }: {
  label: string; children: React.ReactNode; onClick(): void; pressed?: boolean; disabled?: boolean; shortcut?: string;
}): JSX.Element {
  return <button type="button" className="preview-tool" aria-label={label} title={shortcut ? label + " (" + shortcut + ")" : label} aria-pressed={pressed}
    disabled={disabled} onClick={onClick}>{children}</button>;
}
