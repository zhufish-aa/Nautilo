import { useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { constrainWorkspacePreview } from "../../lib/workspace-state";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { WorkPreviewPane } from "../work/WorkPreviewPane";
import "../../styles/workspace-preview.css";

const widthKey = "nautilo.workspacePreview.width";

export interface PreviewFileRequest { path: string; diff?: string }

export function WorkspacePreview({ sessionId, request, onClose, onQuote }: {
  sessionId: string;
  request: PreviewFileRequest;
  onClose(): void;
  onQuote(reference: string): void;
}): JSX.Element {
  const [width, setWidth] = useState(() => Number(localStorage.getItem(widthKey)) || 0);
  const [available, setAvailable] = useState(1000);
  const [wide, setWide] = useState(false);
  const [dragging, setDragging] = useState(false);
  const reduced = useUiReducedMotion();
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number; next?: number }>();
  const overlay = window.innerWidth <= 1100;
  const fitWidth = (next: number): number => overlay
    ? Math.min(available, Math.max(300, next))
    : constrainWorkspacePreview(next, available);
  const actual = fitWidth(wide ? available : width || available * .45);

  useLayoutEffect(() => {
    const node = panel.current!;
    const parent = node.parentElement!;
    const measure = (): void => setAvailable(parent.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    const previous = document.activeElement as HTMLElement | null;
    node.focus({ preventScroll: true });
    return () => {
      observer.disconnect();
      if (previous?.isConnected && (node.contains(document.activeElement) || document.activeElement === document.body)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  function remember(next: number): void {
    setWidth(next);
    if (next) localStorage.setItem(widthKey, String(next));
    else localStorage.removeItem(widthKey);
  }

  return <motion.aside ref={panel} aria-label="文件预览" className="workspace-preview" tabIndex={-1}
    style={{ width: actual }} data-dragging={dragging} data-reduced-motion={reduced}
    initial={reduced ? false : { opacity: 0 }}
    animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .15, ease: [.2, .8, .2, 1] }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented && !(event.target as Element).closest(".find-widget")) {
        event.stopPropagation();
        onClose();
      }
    }}>
    <div role="separator" aria-label="调整预览宽度" aria-orientation="vertical" aria-valuenow={Math.round(actual)}
      aria-valuemin={Math.min(300, available)} aria-valuemax={fitWidth(available)} tabIndex={0}
      className="preview-resize"
      onDoubleClick={() => { setWide(false); remember(0); }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = { x: event.clientX, width: actual };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current || event.clientX === drag.current.x && drag.current.next === undefined) return;
        const next = fitWidth(drag.current.width + drag.current.x - event.clientX);
        drag.current.next = next;
        setWide(false);
        setWidth(next);
      }}
      onLostPointerCapture={() => {
        if (drag.current?.next !== undefined) remember(drag.current.next);
        drag.current = undefined;
        setDragging(false);
      }}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
        event.preventDefault();
        setWide(false);
        remember(event.key === "Home" ? 0 : fitWidth(actual + (event.key === "ArrowLeft" ? 40 : -40)));
      }} />
    <WorkPreviewPane sessionId={sessionId} request={request} onClose={onClose} wide={wide}
      onToggleWide={() => setWide(!wide)} onQuote={onQuote} />
  </motion.aside>;
}
