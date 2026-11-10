import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Copy, Download, FolderOpen, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useLightboxStore } from "../../stores/lightbox";
import { copyImageToClipboard, popupImageMenu, saveImageAs } from "./media-actions";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/** Full-screen image preview: wheel/buttons zoom, drag to pan, Esc or backdrop to close. */
export function ImageLightbox(): JSX.Element {
  const { t } = useI18n();
  const image = useLightboxStore((state) => state.image);
  const close = useLightboxStore((state) => state.close);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const resetView = useCallback((): void => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    if (!image) return;
    resetView();
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.stopPropagation(); close(); }
      if (event.key === "Tab") {
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
        if (!buttons?.length) return;
        const first = buttons[0]; const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); if (previous?.isConnected) previous.focus(); };
  }, [image, close, resetView]);

  // React attaches wheel listeners as passive; a native listener lets us preventDefault.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !image) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      setZoom((current) => {
        const next = clampZoom(current * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
        if (next === 1) setOffset({ x: 0, y: 0 });
        return next;
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [image]);

  const toolbarButton = "flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors hover:bg-card-hover hover:text-ink";

  return createPortal(
    <AnimatePresence>
      {image && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/25"
          onClick={close}
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={image.name ?? t("sessions.media.enlargeHint")}
        >
          <div className="relative flex h-[80vh] w-[88vw] max-w-6xl flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-pop" onClick={(event) => event.stopPropagation()}>
          <div
            className="z-10 flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-4 py-3"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="mr-auto min-w-0 max-w-[40%] truncate text-sm font-medium">{image.name}</span>
            <button type="button" className={toolbarButton} title={t("sessions.media.zoomOut")} aria-label={t("sessions.media.zoomOut")}
              onClick={() => setZoom((value) => clampZoom(value / 1.25))}>
              <ZoomOut className="h-4 w-4" aria-hidden />
            </button>
            <span className="w-12 text-center font-mono text-xs text-ink-3">{Math.round(zoom * 100)}%</span>
            <button type="button" className={toolbarButton} title={t("sessions.media.zoomIn")} aria-label={t("sessions.media.zoomIn")}
              onClick={() => setZoom((value) => clampZoom(value * 1.25))}>
              <ZoomIn className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" className={toolbarButton} title={t("sessions.media.zoomReset")} aria-label={t("sessions.media.zoomReset")} onClick={resetView}>
              <RotateCcw className="h-4 w-4" aria-hidden />
            </button>
            <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
            <button type="button" className={toolbarButton} title={t("sessions.media.copyImage")} aria-label={t("sessions.media.copyImage")}
              onClick={() => void copyImageToClipboard(image, t)}>
              <Copy className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" className={toolbarButton} title={t("sessions.media.saveImageAs")} aria-label={t("sessions.media.saveImageAs")}
              onClick={() => void saveImageAs(image, t)}>
              <Download className="h-4 w-4" aria-hidden />
            </button>
            {image.path && (
              <button type="button" className={toolbarButton} title={t("sessions.media.showInFolder")} aria-label={t("sessions.media.showInFolder")}
                onClick={() => void window.agenthub?.shell.showItemInFolder(image.path!)}>
                <FolderOpen className="h-4 w-4" aria-hidden />
              </button>
            )}
            <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
            <button ref={closeRef} type="button" className={toolbarButton} title={t("sessions.media.closePreview")} aria-label={t("sessions.media.closePreview")} onClick={close}>
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <div
            ref={stageRef}
            className={cn("flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden p-6", zoom > 1 && (dragging ? "cursor-grabbing" : "cursor-grab"))}
            onClick={(event) => {
              event.stopPropagation();
              // Clicks on empty stage area close; clicks on the image itself don't.
              if (event.target === event.currentTarget) close();
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || zoom <= 1) return;
              dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, baseX: offset.x, baseY: offset.y };
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              setOffset({ x: drag.baseX + event.clientX - drag.startX, y: drag.baseY + event.clientY - drag.startY });
            }}
            onPointerUp={(event) => {
              if (dragRef.current?.pointerId !== event.pointerId) return;
              dragRef.current = null;
              setDragging(false);
            }}
            onPointerCancel={() => {
              dragRef.current = null;
              setDragging(false);
            }}
            onDoubleClick={() => (zoom === 1 ? setZoom(2.5) : resetView())}
          >
            <img
              key={image.src}
              src={image.src}
              alt={image.name ?? ""}
              draggable={false}
              onContextMenu={(event) => {
                event.preventDefault();
                void popupImageMenu(image, t);
              }}
              className="max-h-full max-w-full select-none object-contain"
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
            />
          </div>

          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
