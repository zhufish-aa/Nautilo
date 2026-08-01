import { useCallback, useEffect, useRef, useState } from "react";
import { FileCode2, FileWarning, FolderOpen, Loader2 } from "lucide-react";
import { Drawer } from "../../components/ui/Drawer";
import { useI18n } from "../../lib/i18n";
import { highlightCode, highlightLine, languageForPath } from "../../lib/highlight";
import { useFilePreviewStore } from "../../stores/file-preview";

type LoadState =
  | { status: "loading" }
  | { status: "error"; reason: "not-found" | "not-file" | "binary" | "read-failed" }
  | { status: "ambiguous"; candidates: string[] }
  // `html` is null in virtual mode: whole-file highlighting is skipped and
  // rows are highlighted lazily per visible line instead.
  | { status: "done"; resolvedPath: string; lines: string[]; html: string | null; truncated: boolean };

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/** Row height shared by the gutter and the code so both stay aligned. */
const LINE_HEIGHT = 20;
/** Vertical padding (py-2) of the code block, included in scroll offsets. */
const BLOCK_PADDING = 8;
/** Above this many lines (or bytes) the drawer switches to virtualized rows. */
const VIRTUALIZE_LINES = 2000;
const VIRTUALIZE_CHARS = 400_000;
/** Extra rows rendered above/below the viewport to avoid blank flashes. */
const OVERSCAN = 20;

/**
 * Virtualized code view for large files: only the visible window is rendered
 * and each row is highlighted on demand (whole-file highlight.js on hundreds
 * of thousands of lines would block the renderer for seconds).
 */
function VirtualizedCode({ lines, language, targetLine }: {
  lines: string[];
  language?: string;
  targetLine?: number;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const highlightCacheRef = useRef(new Map<number, string>());
  const [range, setRange] = useState({ start: 0, end: 80 });

  const updateRange = useCallback((): void => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element) return;
      const start = Math.max(0, Math.floor(element.scrollTop / LINE_HEIGHT) - OVERSCAN);
      const end = Math.min(lines.length, Math.ceil((element.scrollTop + element.clientHeight) / LINE_HEIGHT) + OVERSCAN);
      setRange((current) => (current.start === start && current.end === end ? current : { start, end }));
    });
  }, [lines.length]);

  useEffect(() => {
    highlightCacheRef.current.clear();
    updateRange();
    const element = scrollRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(updateRange);
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameRef.current);
    };
  }, [updateRange]);

  // Center the referenced line once on mount (scrollIntoView cannot reach
  // rows that are not rendered yet).
  const targetScrollDoneRef = useRef(false);
  useEffect(() => {
    if (targetScrollDoneRef.current) return;
    const element = scrollRef.current;
    if (!element || targetLine === undefined || targetLine < 1 || targetLine > lines.length) return;
    targetScrollDoneRef.current = true;
    element.scrollTop = Math.max(0, (targetLine - 1) * LINE_HEIGHT - element.clientHeight / 2);
    updateRange();
  }, [targetLine, lines.length, updateRange]);

  const htmlFor = (index: number): string => {
    const cache = highlightCacheRef.current;
    const cached = cache.get(index);
    if (cached !== undefined) return cached;
    const html = highlightLine(lines[index] ?? "", language);
    if (cache.size > 5000) cache.clear();
    cache.set(index, html);
    return html;
  };

  const gutterRows: JSX.Element[] = [];
  const codeRows: JSX.Element[] = [];
  for (let index = range.start; index < range.end; index += 1) {
    const lineNumber = index + 1;
    const highlighted = targetLine === lineNumber;
    gutterRows.push(
      <div key={lineNumber} className={highlighted ? "font-semibold text-accent" : undefined}>
        {lineNumber}
      </div>
    );
    codeRows.push(
      // eslint-disable-next-line react/no-danger -- html is escaped/built by highlight.js
      <div key={lineNumber} className="whitespace-pre" dangerouslySetInnerHTML={{ __html: htmlFor(index) }} />
    );
  }

  return (
    <div ref={scrollRef} onScroll={updateRange} className="min-h-0 flex-1 overflow-auto">
      <div className="relative flex min-w-fit" style={{ height: lines.length * LINE_HEIGHT + BLOCK_PADDING * 2 }}>
        {targetLine !== undefined && targetLine >= 1 && targetLine <= lines.length && (
          <div
            aria-hidden
            className="absolute inset-x-0 bg-accent-soft"
            style={{ top: BLOCK_PADDING + (targetLine - 1) * LINE_HEIGHT, height: LINE_HEIGHT }}
          />
        )}
        <div className="sticky left-0 z-10 shrink-0 select-none overflow-hidden border-r border-line bg-card pl-4 pr-3 text-right font-mono text-[12px] leading-[20px] text-ink-3/70">
          <div style={{ transform: `translateY(${BLOCK_PADDING + range.start * LINE_HEIGHT}px)` }}>
            {gutterRows}
          </div>
        </div>
        <pre className="min-w-0 flex-1 pl-4 pr-4 font-mono text-[12px] leading-[20px] text-ink-2">
          <div aria-hidden style={{ height: BLOCK_PADDING + range.start * LINE_HEIGHT }} />
          {codeRows}
        </pre>
      </div>
    </div>
  );
}

/** Right-side code preview for file references clicked in the conversation. */
export function FilePreviewDrawer(): JSX.Element {
  const { t } = useI18n();
  const target = useFilePreviewStore((state) => state.target);
  const basePaths = useFilePreviewStore((state) => state.basePaths);
  const close = useFilePreviewStore((state) => state.close);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const highlightRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (path: string): Promise<void> => {
      const requestId = ++requestIdRef.current;
      setState({ status: "loading" });
      const bridge = window.agenthub;
      if (!bridge) {
        setState({ status: "error", reason: "read-failed" });
        return;
      }
      try {
        const result = await bridge.files.readText({ path, basePaths });
        if (requestId !== requestIdRef.current) return;
        if (!result.ok) {
          if (result.reason === "ambiguous") {
            setState({ status: "ambiguous", candidates: result.candidates });
          } else {
            setState({ status: "error", reason: result.reason });
          }
        } else {
          const lines = result.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
          const virtual = lines.length > VIRTUALIZE_LINES || result.content.length > VIRTUALIZE_CHARS;
          setState({
            status: "done",
            resolvedPath: result.resolvedPath,
            lines,
            html: virtual ? null : highlightCode(result.content, result.resolvedPath),
            truncated: result.truncated
          });
        }
      } catch {
        if (requestId === requestIdRef.current) setState({ status: "error", reason: "read-failed" });
      }
    },
    [basePaths]
  );

  useEffect(() => {
    if (target) void load(target.path);
  }, [target, load]);

  const virtual = state.status === "done" && state.html === null;

  useEffect(() => {
    if (state.status === "done" && !virtual && target?.line !== undefined) {
      highlightRef.current?.scrollIntoView({ block: "center" });
    }
  }, [state, target, virtual]);

  const errorKey = state.status === "error"
    ? state.reason === "not-found"
      ? "sessions.filePreview.notFound"
      : state.reason === "not-file"
        ? "sessions.filePreview.notFile"
        : state.reason === "binary"
          ? "sessions.filePreview.binary"
          : "sessions.filePreview.readFailed"
    : null;

  return (
    <Drawer
      open={target !== null}
      onClose={close}
      title={target ? basename(target.path) : ""}
      subtitle={state.status === "done" ? state.resolvedPath : target?.path}
      defaultWidth={Math.min(Math.round(window.innerWidth * 0.6), 960)}
      minWidth={480}
    >
      {target && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2 text-[11px] text-ink-3">
            {state.status === "done" && (
              <span>
                {t("sessions.filePreview.lines", { count: state.lines.length })}
                {target.line !== undefined && ` · ${t("sessions.filePreview.lineHint", { line: target.line })}`}
              </span>
            )}
            {state.status === "done" && state.truncated && (
              <span className="rounded bg-warn/10 px-1.5 py-0.5 text-warn">{t("sessions.filePreview.truncated")}</span>
            )}
            {state.status === "done" && virtual && (
              <span className="rounded bg-info/10 px-1.5 py-0.5 text-info">{t("sessions.filePreview.largeFile")}</span>
            )}
            {state.status === "done" && (
              <button
                type="button"
                onClick={() => void window.agenthub?.shell.showItemInFolder(state.resolvedPath)}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-ink-3 transition-colors hover:bg-card-hover hover:text-ink"
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                {t("sessions.filePreview.showInFolder")}
              </button>
            )}
          </div>

          {state.status === "loading" && (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-ink-3">
              <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
              {t("sessions.filePreview.loading")}
            </div>
          )}

          {state.status === "error" && errorKey && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <FileWarning className="h-6 w-6 text-warn" aria-hidden />
              <p className="text-sm text-ink-2">{t(errorKey)}</p>
              <p className="max-w-full truncate font-mono text-xs text-ink-3" title={target.path}>{target.path}</p>
            </div>
          )}

          {state.status === "ambiguous" && (
            <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
              <p className="mb-1 text-sm font-medium text-ink">{t("sessions.filePreview.ambiguous")}</p>
              <p className="mb-3 text-xs text-ink-3">{t("sessions.filePreview.ambiguousHint")}</p>
              <ul className="space-y-1">
                {state.candidates.map((candidate) => (
                  <li key={candidate}>
                    <button
                      type="button"
                      title={candidate}
                      onClick={() => void load(candidate)}
                      className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 text-left font-mono text-xs text-ink-2 transition-colors hover:border-accent/50 hover:bg-card-hover hover:text-ink"
                    >
                      <FileCode2 className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
                      <span className="truncate" style={{ direction: "rtl", textAlign: "left" }}>{candidate}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {state.status === "done" && virtual && (
            <VirtualizedCode lines={state.lines} language={languageForPath(state.resolvedPath)} targetLine={target.line} />
          )}

          {state.status === "done" && !virtual && (
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="relative flex min-w-fit">
                {target.line !== undefined && target.line >= 1 && target.line <= state.lines.length && (
                  <div
                    aria-hidden
                    className="absolute inset-x-0 bg-accent-soft"
                    style={{ top: 8 + (target.line - 1) * LINE_HEIGHT, height: LINE_HEIGHT }}
                  />
                )}
                <div className="sticky left-0 z-10 shrink-0 select-none border-r border-line bg-card py-2 pl-4 pr-3 text-right font-mono text-[12px] leading-[20px] text-ink-3/70">
                  {state.lines.map((_, index) => {
                    const lineNumber = index + 1;
                    const highlighted = target.line === lineNumber;
                    return (
                      <div
                        key={lineNumber}
                        ref={highlighted ? highlightRef : undefined}
                        className={highlighted ? "font-semibold text-accent" : undefined}
                      >
                        {lineNumber}
                      </div>
                    );
                  })}
                </div>
                <pre className="min-w-0 flex-1 py-2 pl-4 pr-4 font-mono text-[12px] leading-[20px] text-ink-2">
                  <code className="hljs whitespace-pre" dangerouslySetInnerHTML={{ __html: state.html ?? "" }} />
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
