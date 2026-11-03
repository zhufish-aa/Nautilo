import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { constrainWorkspacePreview } from "../../lib/workspace-state";
import { WorkPreviewPane } from "../work/WorkPreviewPane";

/** Session-scoped contextual preview; no second conversation or mode is mounted. */
export function WorkspacePreview({ sessionId, path, onClose }: { sessionId: string; path?: string; onClose(): void }): JSX.Element {
  const [width, setWidth] = useState(460);
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const start = useRef<{ x: number; width: number }>();
  const clamp = (next: number): number => constrainWorkspacePreview(next, panel.current?.parentElement?.clientWidth ?? 1000);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <aside ref={panel} aria-label="文件预览" className="workspace-preview relative flex h-full shrink-0 flex-col border-l border-line bg-card" style={{ width }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <div role="separator" aria-label="调整预览宽度" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={300} tabIndex={0}
      onPointerDown={(event) => { start.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (start.current) setWidth(clamp(start.current.width + start.current.x - event.clientX)); }}
      onPointerUp={(event) => { start.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { start.current = undefined; }}
      onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setWidth((current) => clamp(current + (event.key === "ArrowLeft" ? 40 : -40))); } }}
      className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none focus-visible:bg-accent/15" />
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4"><span className="text-sm font-medium">预览</span><button ref={close} onClick={onClose} type="button" aria-label="关闭预览" className="rounded-md p-1.5 text-ink-3 hover:bg-panel focus-visible:ring-2 focus-visible:ring-accent"><X className="h-4 w-4" /></button></header>
    <div className="min-h-0 flex-1"><WorkPreviewPane sessionId={sessionId} requestedPath={path} /></div>
  </aside>;
}
