import { useEffect, useRef, useState, type ReactNode } from "react";
import "./workspace-panels.css";
import { Maximize2, Minimize2, X } from "lucide-react";
import { useI18n } from "../../lib/i18n";

/** Contextual, non-modal workspace panel: chat and its controls stay available. */
export function WorkspaceDrawer({ open, onClose, title, subtitle, children, defaultWidth = 580, placement = "right", headerContent, headerActions, resizable = false, defaultHeight = 320, storageKey }: {
  open: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode;
  defaultWidth?: number; minWidth?: number; placement?: "right" | "bottom";
  headerContent?: ReactNode; headerActions?: ReactNode; resizable?: boolean; defaultHeight?: number; storageKey?: string;
}): JSX.Element | null {
  const { t, locale } = useI18n();
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [height, setHeight] = useState(() => {
    try { const saved = storageKey && Number(window.localStorage.getItem(storageKey)); if (saved && Number.isFinite(saved)) return saved; } catch { /* Storage can be unavailable. */ }
    return defaultHeight;
  });
  const [availableHeight, setAvailableHeight] = useState(defaultHeight + 180);
  const [maximized, setMaximized] = useState(false);
  const drag = useRef<{ y: number; height: number; cursor: string; userSelect: string }>();
  const adjustable = resizable && placement === "bottom";
  const minHeight = Math.min(160, availableHeight);
  const maxHeight = Math.max(minHeight, availableHeight - 160);
  const clamp = (value: number): number => Math.round(Math.min(maxHeight, Math.max(minHeight, value)));
  const renderedHeight = clamp(height);
  const saveHeight = (value: number): void => { try { if (storageKey) window.localStorage.setItem(storageKey, String(value)); } catch { /* Keep the in-memory size. */ } };
  const finishDrag = (): void => {
    if (!drag.current) return;
    document.body.style.cursor = drag.current.cursor;
    document.body.style.userSelect = drag.current.userSelect;
    drag.current = undefined;
  };
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && panel.current?.contains(document.activeElement)) { event.stopPropagation(); close.current(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); finishDrag(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [open]);
  useEffect(() => {
    if (!open || !adjustable) return;
    const parent = panel.current?.parentElement;
    if (!parent) return;
    const measure = (): void => { if (parent.clientHeight) setAvailableHeight(parent.clientHeight); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [open, adjustable]);
  if (!open) return null;
  return <aside ref={panel} tabIndex={-1} role="region" aria-label={title}
    style={placement === "right" ? { width: `min(${defaultWidth}px, 100%)` } : adjustable && !maximized ? { height: renderedHeight } : undefined}
    className={placement === "right" ? "workspace-panel-right z-30 flex max-w-full shrink-0 flex-col border-l border-line bg-panel outline-none" : `workspace-panel-bottom ${maximized ? "is-maximized" : ""} ${adjustable ? "is-resizable" : ""} relative z-20 flex shrink-0 flex-col border-t border-line bg-panel outline-none`}>
    {adjustable && !maximized && <div role="separator" tabIndex={0} aria-orientation="horizontal" aria-label={locale === "zh-CN" ? "调整终端高度" : "Resize terminal"}
      aria-valuemin={minHeight} aria-valuemax={maxHeight} aria-valuenow={renderedHeight} className="workspace-panel-resize"
      title={locale === "zh-CN" ? "拖动调整高度，双击最大化" : "Drag to resize, double-click to maximize"}
      onDoubleClick={() => setMaximized(true)}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { y: event.clientY, height: renderedHeight, cursor: document.body.style.cursor, userSelect: document.body.style.userSelect }; document.body.style.cursor = "ns-resize"; document.body.style.userSelect = "none"; }}
      onPointerMove={event => { if (drag.current) setHeight(clamp(drag.current.height + drag.current.y - event.clientY)); }}
      onPointerUp={event => { if (!drag.current) return; const next = clamp(drag.current.height + drag.current.y - event.clientY); setHeight(next); saveHeight(next); finishDrag(); event.currentTarget.releasePointerCapture(event.pointerId); }}
      onLostPointerCapture={finishDrag}
      onKeyDown={event => { const next = event.key === "ArrowUp" ? renderedHeight + 32 : event.key === "ArrowDown" ? renderedHeight - 32 : event.key === "Home" ? minHeight : event.key === "End" ? maxHeight : undefined; if (next === undefined) return; event.preventDefault(); const value = clamp(next); setHeight(value); saveHeight(value); }} />}
    <header className={adjustable ? "workspace-panel-toolbar" : "flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3"}>
      {headerContent ?? <h2 className="text-sm font-medium" title={subtitle}>{title}</h2>}
      <div className="workspace-panel-actions">
        {headerActions}
        {adjustable && <button type="button" onClick={() => setMaximized(value => !value)} aria-label={locale === "zh-CN" ? (maximized ? "还原终端" : "最大化终端") : (maximized ? "Restore terminal" : "Maximize terminal")} title={locale === "zh-CN" ? (maximized ? "还原终端" : "最大化终端") : (maximized ? "Restore terminal" : "Maximize terminal")} className="workspace-panel-icon">
          {maximized ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
        </button>}
        <button type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")} className="workspace-panel-icon"><X size={16} aria-hidden /></button>
      </div>
    </header>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
  </aside>;
}
