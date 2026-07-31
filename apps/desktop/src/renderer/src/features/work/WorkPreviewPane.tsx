import { useEffect, useMemo, useState } from "react";
import { FileIcon, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { Button } from "../../components/ui/Button";
import { requestCore } from "../../lib/bridge";
import { collectChangedFiles } from "../../lib/changed-files";
import { base64ToBytes, base64ToText, docxToHtml, formatFileSize, previewKind, xlsxToHtml, type WorkPreviewKind } from "../../lib/work-preview";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { MarkdownContent } from "../timeline/MarkdownContent";
import { openFileWithToast } from "../timeline/media-actions";

type PreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; kind: WorkPreviewKind; html?: string; text?: string; blobUrl?: string; size: number; modifiedAt: string };

// Parsed previews survive pane remounts (Code↔Work switches): docx/xlsx
// parsing is the expensive part and a file only changes when its mtime does.
const PARSE_CACHE_LIMIT = 30;
const parseCache = new Map<string, { html?: string; text?: string }>();

/**
 * Right-hand deliverable pane for Work sessions: lists files the agent
 * produced and renders the selected one (docx/xlsx/md/html/csv/img/text).
 */
export function WorkPreviewPane({ sessionId }: { sessionId: string }): JSX.Element {
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
  const activePath = selected ?? deliverables[0];
  const [preview, setPreview] = useState<PreviewState>({ status: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  // Re-read only when the agent actually touched files, not on every token.
  const fileTouchCount = useMemo(
    () => (events ?? []).reduce((count, event) => count + (event.data.kind === "file_change" ? 1 : 0), 0),
    [events]
  );

  // Reload when the file's mtime changes (agent rewrites it mid-run).
  useEffect(() => {
    if (!activePath || !project) {
      setPreview({ status: "error", message: "" });
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    const load = async (): Promise<void> => {
      setPreview((current) => current.status === "ready" ? current : { status: "loading" });
      try {
        const file = await requestCore<{ base64: string; mimeType: string; size: number; modifiedAt: string }>(
          "artifact.read",
          { projectId: project.id, path: activePath }
        );
        if (cancelled) return;
        const kind = previewKind(activePath);
        const next: PreviewState = { status: "ready", kind, size: file.size, modifiedAt: file.modifiedAt };
        const cacheKey = `${activePath}:${file.modifiedAt}`;
        const cached = parseCache.get(cacheKey);
        if (cached) {
          next.html = cached.html;
          next.text = cached.text;
        } else if (kind === "docx") next.html = await docxToHtml(base64ToBytes(file.base64));
        else if (kind === "xlsx") next.html = await xlsxToHtml(base64ToBytes(file.base64));
        else if (kind === "markdown" || kind === "text") next.text = base64ToText(file.base64);
        else if (kind === "csv") next.text = base64ToText(file.base64);
        else if (kind === "html") next.html = base64ToText(file.base64);
        if (!cached && (next.html !== undefined || next.text !== undefined)) {
          if (parseCache.size >= PARSE_CACHE_LIMIT) {
            const oldest = parseCache.keys().next().value;
            if (oldest !== undefined) parseCache.delete(oldest);
          }
          parseCache.set(cacheKey, { html: next.html, text: next.text });
        }
        if (kind === "image") {
          objectUrl = URL.createObjectURL(new Blob([base64ToBytes(file.base64) as BlobPart], { type: file.mimeType }));
          next.blobUrl = objectUrl;
        }
        if (cancelled) return;
        setPreview((current) => {
          if (current.status === "ready" && current.blobUrl && current.blobUrl !== objectUrl) URL.revokeObjectURL(current.blobUrl);
          return next;
        });
      } catch (error) {
        if (!cancelled) setPreview({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // modifiedAt-driven refresh: re-runs when the agent touches files, when
    // the selection changes, or on manual reload — never per streaming token.
  }, [activePath, project, fileTouchCount, reloadTick]);

  if (deliverables.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <FileIcon className="h-8 w-8 text-ink-3/50" aria-hidden />
        <p className="text-sm text-ink-3">{t("work.preview.empty")}</p>
        <p className="text-xs text-ink-3/70">{t("work.preview.emptyHint")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line/70 px-2 py-1.5">
        {deliverables.map((path) => {
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
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setReloadTick((tick) => tick + 1)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-card-hover hover:text-ink"
            aria-label={t("work.preview.reload")}
            title={t("work.preview.reload")}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => activePath && void openFileWithToast(activePath, t)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-card-hover hover:text-ink"
            aria-label={t("work.preview.openExternal")}
            title={t("work.preview.openExternal")}
          >
            <FolderOpen className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {preview.status === "loading" && (
          <div className="flex h-full items-center justify-center text-ink-3">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          </div>
        )}
        {preview.status === "error" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm text-ink-3">{t("work.preview.error")}</p>
            {preview.message && <p className="max-w-sm text-xs text-ink-3/70">{preview.message}</p>}
          </div>
        )}
        {preview.status === "ready" && (
          <PreviewBody preview={preview} path={activePath!} />
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

function PreviewBody({ preview, path }: { preview: Extract<PreviewState, { status: "ready" }>; path: string }): JSX.Element {
  const { t } = useI18n();
  switch (preview.kind) {
    case "docx":
    case "xlsx":
      return (
        <div
          className="work-preview-doc prose-sm mx-auto max-w-3xl px-6 py-6 text-ink [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line [&_th]:bg-card-hover [&_th]:px-2 [&_th]:py-1"
          dangerouslySetInnerHTML={{ __html: preview.html ?? "" }}
        />
      );
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
        <div className="mx-auto max-w-3xl px-6 py-6 text-[14px] leading-7 text-ink">
          <MarkdownContent source={preview.text ?? ""} inverted={false} />
        </div>
      );
    case "csv":
    case "text":
      return (
        <pre className="min-h-full whitespace-pre-wrap break-words bg-card/40 px-5 py-4 font-mono text-[12px] leading-5 text-ink-2">
          {preview.text}
        </pre>
      );
    case "image":
      return (
        <div className="flex h-full items-center justify-center p-4">
          <img src={preview.blobUrl} alt={path} className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      );
    case "pptx-unsupported":
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <FileIcon className="h-10 w-10 text-ink-3/50" aria-hidden />
          <p className="text-sm text-ink-2">{t("work.preview.pptxUnsupported")}</p>
          <Button variant="outline" size="sm" onClick={() => void openFileWithToast(path, t)}>
            <FolderOpen className="h-4 w-4" aria-hidden />
            {t("work.preview.openExternal")}
          </Button>
        </div>
      );
    default:
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <FileIcon className="h-10 w-10 text-ink-3/50" aria-hidden />
          <p className="text-sm text-ink-2">{t("work.preview.binaryUnsupported")}</p>
          <Button variant="outline" size="sm" onClick={() => void openFileWithToast(path, t)}>
            <FolderOpen className="h-4 w-4" aria-hidden />
            {t("work.preview.openExternal")}
          </Button>
        </div>
      );
  }
}
