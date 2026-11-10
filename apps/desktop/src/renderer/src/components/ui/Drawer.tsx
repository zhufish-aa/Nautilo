import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../lib/i18n";

/** Modal file/detail drawer. Radix owns focus trapping, Escape and restoration. */
export function Drawer({ open, onClose, title, subtitle, children, defaultWidth = 520, minWidth = 380 }: {
  open: boolean; onClose(): void; title: string; subtitle?: string; children: ReactNode; defaultWidth?: number; minWidth?: number;
}): JSX.Element {
  const { t } = useI18n();
  const descriptionId = useId();
  const [width, setWidth] = useState(defaultWidth);
  const drag = useRef<{ x: number; width: number }>();
  useEffect(() => { if (open) setWidth(defaultWidth); }, [open, defaultWidth]);
  const clamp = (value: number): number => Math.min(window.innerWidth * 0.94, Math.max(minWidth, value));
  return <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="ui-drawer-overlay fixed inset-0 z-40 bg-black/20" />
      <DialogPrimitive.Content aria-describedby={subtitle ? descriptionId : undefined} style={{ width }} className="ui-drawer fixed inset-y-0 right-0 z-50 flex max-w-[94vw] flex-col border-l border-line bg-card shadow-pop outline-none">
        <div role="separator" aria-orientation="vertical" aria-label={t("work.preview.resize")} aria-valuenow={width} tabIndex={0}
          onPointerDown={(event) => { drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={(event) => { if (drag.current) setWidth(clamp(drag.current.width + drag.current.x - event.clientX)); }}
          onPointerUp={(event) => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => { drag.current = undefined; }}
          onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setWidth((current) => clamp(current + (event.key === "ArrowLeft" ? 24 : -24))); } }}
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-ew-resize touch-none outline-none focus-visible:bg-accent/15" />
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4"><div className="min-w-0"><DialogPrimitive.Title className="text-sm font-medium text-ink">{title}</DialogPrimitive.Title>{subtitle && <DialogPrimitive.Description id={descriptionId} className="mt-1 text-sm text-ink-3">{subtitle}</DialogPrimitive.Description>}</div><DialogPrimitive.Close aria-label={t("common.close")} className="rounded-md p-1.5 text-ink-3 hover:bg-panel focus-visible:ring-2 focus-visible:ring-accent"><X className="h-4 w-4" /></DialogPrimitive.Close></header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
