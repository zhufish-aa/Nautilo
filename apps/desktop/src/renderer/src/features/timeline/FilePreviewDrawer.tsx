import { useCallback, useEffect, useRef, useState } from "react";
import { FileCode2, FileWarning, FolderOpen, Loader2 } from "lucide-react";
import { Drawer } from "../../components/ui/Drawer";
import { useI18n } from "../../lib/i18n";
import { highlightCode } from "../../lib/highlight";
import { useFilePreviewStore } from "../../stores/file-preview";

type LoadState =
  | { status: "loading" }
  | { status: "error"; reason: "not-found" | "not-file" | "binary" | "read-failed" }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "done"; resolvedPath: string; lines: string[]; html: string; truncated: boolean };

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/** Row height shared by the gutter and the code so both stay aligned. */
const LINE_HEIGHT = 20;

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
          setState({
            status: "done",
            resolvedPath: result.resolvedPath,
            lines: result.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n"),
            html: highlightCode(result.content, result.resolvedPath),
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

  useEffect(() => {
    if (state.status === "done" && target?.line !== undefined) {
      highlightRef.current?.scrollIntoView({ block: "center" });
    }
  }, [state, target]);

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

          {state.status === "done" && (
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
                  <code className="hljs whitespace-pre" dangerouslySetInnerHTML={{ __html: state.html }} />
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
