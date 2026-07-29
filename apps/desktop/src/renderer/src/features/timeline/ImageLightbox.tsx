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
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const resetView = useCallback((): void => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    if (!image) return;
    resetView();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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

  const toolbarButton = "flex h-8 w-8 items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/15 hover:text-white";

  return createPortal(
    <AnimatePresence>
      {image && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={close}
          role="dialog"
          aria-modal="true"
          aria-label={image.name ?? t("sessions.media.enlargeHint")}
        >
          <div
            className="absolute right-4 top-4 z-10 flex items-center gap-1 rounded-xl border border-white/10 bg-black/50 p-1"
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" className={toolbarButton} title={t("sessions.media.zoomOut")} aria-label={t("sessions.media.zoomOut")}
              onClick={() => setZoom((value) => clampZoom(value / 1.25))}>
              <ZoomOut className="h-4 w-4" aria-hidden />
            </button>
            <span className="w-12 text-center font-mono text-[11px] text-white/70">{Math.round(zoom * 100)}%</span>
            <button type="button" className={toolbarButton} title={t("sessions.media.zoomIn")} aria-label={t("sessions.media.zoomIn")}
              onClick={() => setZoom((value) => clampZoom(value * 1.25))}>
              <ZoomIn className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" className={toolbarButton} title={t("sessions.media.zoomReset")} aria-label={t("sessions.media.zoomReset")} onClick={resetView}>
              <RotateCcw className="h-4 w-4" aria-hidden />
            </button>
            <span className="mx-0.5 h-5 w-px bg-white/15" aria-hidden />
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
            <span className="mx-0.5 h-5 w-px bg-white/15" aria-hidden />
            <button type="button" className={toolbarButton} title={t("sessions.media.closePreview")} aria-label={t("sessions.media.closePreview")} onClick={close}>
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <div
            ref={stageRef}
            className={cn("flex h-full w-full items-center justify-center overflow-hidden", zoom > 1 && (dragging ? "cursor-grabbing" : "cursor-grab"))}
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
            <motion.img
              key={image.src}
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              src={image.src}
              alt={image.name ?? ""}
              draggable={false}
              onContextMenu={(event) => {
                event.preventDefault();
                void popupImageMenu(image, t);
              }}
              className="max-h-[88vh] max-w-[92vw] select-none object-contain shadow-2xl"
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
            />
          </div>

          {image.name && (
            <div className="pointer-events-none absolute bottom-4 left-1/2 max-w-[80vw] -translate-x-1/2 truncate rounded-lg bg-black/50 px-3 py-1.5 text-xs text-white/80">
              {image.name}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
