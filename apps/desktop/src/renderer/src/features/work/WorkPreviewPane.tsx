import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileIcon,
  FolderOpen,
  Loader2,
  RefreshCw,
  StretchHorizontal,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { Button } from "../../components/ui/Button";
import { requestCore } from "../../lib/bridge";
import { collectChangedFiles } from "../../lib/changed-files";
import {
  base64ToBytes,
  base64ToText,
  createLruCache,
  formatFileSize,
  MAX_PREVIEW_BYTES,
  mergeDeliverableTabs,
  OFFICE_KINDS,
  previewCacheKey,
  resolvePreview,
  resolveRequestedTab,
  type PreviewErrorReason,
  type WorkPreviewKind
} from "../../lib/work-preview";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { MarkdownContent } from "../timeline/MarkdownContent";
import { openFileWithToast } from "../timeline/media-actions";
import { DocumentPreview } from "./preview/DocumentPreview";
import type { PreviewNavState, PreviewZoom } from "./preview/types";

type PaneStatus = "idle" | "loading-file" | "parsing" | "ready" | "error" | "unsupported";

interface PaneState {
  status: PaneStatus;
  kind?: WorkPreviewKind;
  size: number;
  modifiedAt: string;
  bytes?: Uint8Array;
  text?: string;
  html?: string;
  blobUrl?: string;
  message?: string;
  reason?: PreviewErrorReason;
}

const INITIAL_STATE: PaneState = { status: "idle", size: 0, modifiedAt: "" };

// Parsed text previews survive pane remounts (Code↔Work switches). Bounded
// LRU keyed by projectId + path + modifiedAt, so it can never grow without
// limit and a rewritten file always invalidates its entry.
const parseCache = createLruCache<{ text: string }>(30);

const ZOOM_MIN = 25;
const ZOOM_MAX = 400;
const ZOOM_STEP = 25;

/**
 * Right-hand deliverable pane for Work sessions: lists files the agent
 * produced and renders the selected one. The pane owns the unified state
 * machine (idle → loading-file → parsing → ready / error / unsupported) and
 * toolbar; office formats are rendered by the components in ./preview.
 */
export function WorkPreviewPane({ sessionId, requestedPath }: { sessionId: string; requestedPath?: string }): JSX.Element {
  const { t } = useI18n();
  const events = useSessionsStore((state) => state.events[sessionId]);
  const session = useSessionsStore((state) => state.sessions.find((item) => item.id === sessionId));
  const project = useProjectsStore((state) => state.projects.find((item) => item.id === session?.projectId));

  // Newest deliverable last in the event stream → show first.
  const deliverables = useMemo(() => {
    const seen = new Set<string>();
    const files: string[] = [];
    for (const entry of [...(events ?? [])].reverse()) {
      for (const file of collectChangedFiles([entry])) {
        if (!seen.has(file.path)) {
          seen.add(file.path);
          files.push(file.path);
        }
      }
    }
    return files;
  }, [events]);

  const [selected, setSelected] = useState<string>();
  // A chat click (Markdown link / chip / artifact / file_change) requests a
  // path that may not be among the deliverables yet: it still becomes a tab
  // (deduplicated case/separator-insensitively) and the active selection.
  const tabs = useMemo(() => mergeDeliverableTabs(deliverables, requestedPath), [deliverables, requestedPath]);
  useEffect(() => {
    if (requestedPath) setSelected(resolveRequestedTab(deliverables, requestedPath));
  }, [requestedPath, deliverables]);
  // Keep-alive: never leak the previous session's selection into this one.
  useEffect(() => {
    setSelected(undefined);
  }, [sessionId]);
  const activePath = selected ?? tabs[0];
  const [preview, setPreview] = useState<PaneState>(INITIAL_STATE);
  const [reloadTick, setReloadTick] = useState(0);
  const [zoom, setZoom] = useState<PreviewZoom>("fit-width");
  const [nav, setNav] = useState<PreviewNavState | null>(null);

  // Stable callbacks for the office renderers — they hang async work off
  // these, so identity must not change per render.
  const handleNav = useCallback((next: PreviewNavState | null) => setNav(next), []);
  const handleReady = useCallback(() => {
    setPreview((current) => (current.status === "parsing" ? { ...current, status: "ready" } : current));
  }, []);
  const handleError = useCallback((message: string, reason: PreviewErrorReason) => {
    setPreview((current) => ({ ...current, status: "error", message, reason }));
  }, []);

  // Reset toolbar state when the selected file changes.
  useEffect(() => {
    setNav(null);
    setZoom("fit-width");
  }, [activePath]);

  // Re-read only when the agent actually touched files, not on every token.
  const fileTouchCount = useMemo(
    () => (events ?? []).reduce((count, event) => count + (event.data.kind === "file_change" ? 1 : 0), 0),
    [events]
  );

  // Load the file bytes; re-runs when the agent touches files, when the
  // selection changes, or on manual reload — never per streaming token.
  useEffect(() => {
    if (!activePath || !project) {
      setPreview(INITIAL_STATE);
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    const load = async (): Promise<void> => {
      setPreview((current) => (current.status === "ready" ? current : { ...INITIAL_STATE, status: "loading-file" }));
      try {
        const file = await requestCore<{ base64: string; mimeType: string; size: number; modifiedAt: string }>(
          "artifact.read",
          { projectId: project.id, path: activePath }
        );
        if (cancelled) return;
        const kind = resolvePreview(activePath, file.mimeType);
        const base: PaneState = { status: "ready", kind, size: file.size, modifiedAt: file.modifiedAt };

        if (file.size > MAX_PREVIEW_BYTES) {
          setPreview({ ...base, status: "error", reason: "too-large" });
          return;
        }
        if (kind === "legacy-office" || kind === "binary") {
          setPreview({ ...base, status: "unsupported" });
          return;
        }
        if (OFFICE_KINDS.includes(kind)) {
          // Office components parse asynchronously and flip parsing → ready.
          setPreview({ ...base, status: "parsing", bytes: base64ToBytes(file.base64) });
          return;
        }
        if (kind === "image") {
          objectUrl = URL.createObjectURL(new Blob([base64ToBytes(file.base64) as BlobPart], { type: file.mimeType }));
          setPreview((current) => {
            if (current.blobUrl && current.blobUrl !== objectUrl) URL.revokeObjectURL(current.blobUrl);
            return { ...base, blobUrl: objectUrl };
          });
          return;
        }
        // markdown / text / csv / html: cached by exact file version.
        const cacheKey = previewCacheKey(project.id, activePath, file.modifiedAt);
        let text = parseCache.get(cacheKey)?.text;
        if (text === undefined) {
          text = base64ToText(file.base64);
          parseCache.set(cacheKey, { text });
        }
        setPreview(kind === "html" ? { ...base, html: text } : { ...base, text });
      } catch (error) {
        if (!cancelled) {
          setPreview({
            ...INITIAL_STATE,
            status: "error",
            message: error instanceof Error ? error.message : String(error),
            reason: "unknown"
          });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [activePath, project, fileTouchCount, reloadTick]);

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <FileIcon className="h-8 w-8 text-ink-3/50" aria-hidden />
        <p className="text-sm text-ink-3">{t("work.preview.empty")}</p>
        <p className="text-xs text-ink-3/70">{t("work.preview.emptyHint")}</p>
      </div>
    );
  }

  const isOffice = preview.kind !== undefined && OFFICE_KINDS.includes(preview.kind);
  const zoomPercent = zoom === "fit-width" ? 100 : zoom;
  const navLabelKey =
    nav?.kind === "page" ? "work.preview.navPage" : nav?.kind === "slide" ? "work.preview.navSlide" : "work.preview.navSheet";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line/70 px-2 py-1.5">
        {tabs.map((path) => {
          const name = path.split(/[\\/]/).pop() ?? path;
          const activeTab = path === activePath;
          return (
            <button
              key={path}
              type="button"
              onClick={() => setSelected(path)}
              title={path}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium transition-colors",
                activeTab ? "bg-accent-soft text-accent" : "text-ink-3 hover:bg-card-hover hover:text-ink"
              )}
            >
              <FileIcon className="h-3 w-3" aria-hidden />
              <span className="max-w-36 truncate">{name}</span>
            </button>
          );
        })}
      </div>

      {/* Unified toolbar: navigation, jump, zoom, fit-width, reload, system open. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line/70 px-2 py-1">
        <ToolbarButton
          label={t("work.preview.prev")}
          disabled={!nav || nav.index <= 0}
          onClick={() => nav?.prev()}
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        </ToolbarButton>
        {nav ? (
          <span className="flex items-center gap-1 text-[11px] tabular-nums text-ink-3">
            <input
              key={`${activePath}:${nav.kind}:${nav.index}`}
              type="number"
              min={1}
              max={nav.count}
              defaultValue={nav.index + 1}
              aria-label={t("work.preview.jumpTo")}
              title={t("work.preview.jumpTo")}
              className="h-6 w-12 rounded-md border border-line bg-panel px-1 text-center text-[11px] text-ink outline-none focus:border-accent"
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                const value = Number.parseInt(event.currentTarget.value, 10);
                if (Number.isFinite(value)) nav.goto(value - 1);
              }}
            />
            <span aria-label={t(navLabelKey, { index: nav.index + 1, count: nav.count })}>
              / {nav.count}
            </span>
          </span>
        ) : (
          <span className="w-[76px]" aria-hidden />
        )}
        <ToolbarButton
          label={t("work.preview.next")}
          disabled={!nav || nav.index >= nav.count - 1}
          onClick={() => nav?.next()}
        >
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </ToolbarButton>

        <span className="mx-1 h-4 w-px bg-line/70" aria-hidden />

        <ToolbarButton
          label={t("work.preview.zoomOut")}
          disabled={!isOffice || zoom === ZOOM_MIN}
          onClick={() => setZoom(Math.max(ZOOM_MIN, zoomPercent - ZOOM_STEP))}
        >
          <ZoomOut className="h-3.5 w-3.5" aria-hidden />
        </ToolbarButton>
        <span className="w-11 text-center text-[11px] tabular-nums text-ink-3">
          {zoom === "fit-width" ? "—" : `${zoomPercent}%`}
        </span>
        <ToolbarButton
          label={t("work.preview.zoomIn")}
          disabled={!isOffice || zoom !== "fit-width" && zoom >= ZOOM_MAX}
          onClick={() => setZoom(Math.min(ZOOM_MAX, zoomPercent + ZOOM_STEP))}
        >
          <ZoomIn className="h-3.5 w-3.5" aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label={t("work.preview.fitWidth")}
          disabled={!isOffice}
          active={zoom === "fit-width"}
          onClick={() => setZoom("fit-width")}
        >
          <StretchHorizontal className="h-3.5 w-3.5" aria-hidden />
        </ToolbarButton>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <ToolbarButton label={t("work.preview.reload")} onClick={() => setReloadTick((tick) => tick + 1)}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </ToolbarButton>
          <ToolbarButton
            label={t("work.preview.openExternal")}
            onClick={() => activePath && void openFileWithToast(activePath, t)}
          >
            <FolderOpen className="h-3.5 w-3.5" aria-hidden />
          </ToolbarButton>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {preview.status === "loading-file" && (
          <div className="flex h-full items-center justify-center text-ink-3">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          </div>
        )}
        {/* Office renderers stay mounted across parsing → ready so the parsed
            result is never thrown away by a status flip. */}
        {isOffice && preview.bytes && (preview.status === "parsing" || preview.status === "ready") && activePath && (
          <DocumentPreview
            path={activePath}
            kind={preview.kind as "pdf" | "docx" | "xlsx" | "pptx"}
            bytes={preview.bytes}
            zoom={zoom}
            onNav={handleNav}
            onReady={handleReady}
            onError={handleError}
          />
        )}
        {preview.status === "parsing" && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center pt-3">
            <span className="flex items-center gap-1.5 rounded-full bg-panel/90 px-3 py-1 text-[11px] text-ink-3 shadow-sm">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              {t("work.preview.parsing")}
            </span>
          </div>
        )}
        {preview.status === "error" && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <FileIcon className="h-10 w-10 text-ink-3/50" aria-hidden />
            <p className="text-sm text-ink-3">{t("work.preview.error")}</p>
            {preview.reason && preview.reason !== "unknown" && (
              <p className="text-xs text-ink-2">{t(`work.preview.reason.${preview.reason}`)}</p>
            )}
            {preview.message && <p className="max-w-sm text-xs text-ink-3/70">{preview.message}</p>}
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setReloadTick((tick) => tick + 1)}>
                <RefreshCw className="h-4 w-4" aria-hidden />
                {t("work.preview.retry")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => activePath && void openFileWithToast(activePath, t)}
              >
                <FolderOpen className="h-4 w-4" aria-hidden />
                {t("work.preview.openExternal")}
              </Button>
            </div>
          </div>
        )}
        {preview.status === "unsupported" && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <FileIcon className="h-10 w-10 text-ink-3/50" aria-hidden />
            <p className="text-sm text-ink-2">
              {preview.kind === "legacy-office"
                ? t("work.preview.legacyUnsupported")
                : t("work.preview.binaryUnsupported")}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => activePath && void openFileWithToast(activePath, t)}
            >
              <FolderOpen className="h-4 w-4" aria-hidden />
              {t("work.preview.openExternal")}
            </Button>
          </div>
        )}
        {preview.status === "ready" && !isOffice && activePath && (
          <ReadyBody preview={preview} path={activePath} />
        )}
      </div>

      {preview.status === "ready" && (
        <div className="flex shrink-0 items-center justify-between border-t border-line/70 px-3 py-1.5 text-[11px] text-ink-3">
          <span className="truncate">{activePath}</span>
          <span className="shrink-0 tabular-nums">{formatFileSize(preview.size)}</span>
        </div>
      )}
    </div>
  );
}

function ToolbarButton({
  label,
  disabled,
  active,
  onClick,
  children
}: {
  label: string;
  disabled?: boolean;
  active?: boolean;
  onClick(): void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
        active ? "bg-accent-soft text-accent" : "text-ink-3 hover:bg-card-hover hover:text-ink",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-ink-3"
      )}
    >
      {children}
    </button>
  );
}

function ReadyBody({ preview, path }: { preview: PaneState; path: string }): JSX.Element {
  switch (preview.kind) {
    case "html":
      return (
        <iframe
          title={path}
          sandbox=""
          srcDoc={preview.html}
          className="h-full w-full border-0 bg-white"
        />
      );
    case "markdown":
      return (
        <div className="h-full overflow-y-auto">
          <div className="mx-auto max-w-3xl px-6 py-6 text-[14px] leading-7 text-ink">
            <MarkdownContent source={preview.text ?? ""} inverted={false} />
          </div>
        </div>
      );
    case "csv":
    case "text":
      return (
        <div className="h-full overflow-y-auto">
          <pre className="min-h-full whitespace-pre-wrap break-words bg-card/40 px-5 py-4 font-mono text-[12px] leading-5 text-ink-2">
            {preview.text}
          </pre>
        </div>
      );
    case "image":
      return (
        <div className="flex h-full items-center justify-center overflow-auto p-4">
          <img src={preview.blobUrl} alt={path} className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      );
    default:
      return <div className="h-full" />;
  }
}
