import { useEffect, useRef, useState, type ReactNode } from "react";
import "./workspace-panels.css";
import "./browser-workspace.css";
import { Maximize2, Minimize2, X, ExternalLink, PanelRightClose } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { getBridge } from "../../lib/bridge";
import { toast } from "../../stores/toast";
import type { PanelTarget } from "../../../../shared/panel-window";
import {ResizeHandle,useRememberedWidth} from "../../components/ui/ResizeHandle";
import { WindowControls } from "../../components/layout/TitleBar";

/** Contextual, non-modal workspace panel: chat and its controls stay available. */
export function WorkspaceDrawer({ open, onClose, title, subtitle, children, defaultWidth = 580, minWidth = 420, adjacentMinWidth = 0, placement = "right", headerContent, headerActions, resizable = false, defaultHeight = 320, defaultMaximized = false, storageKey, keepMounted = false, className = "", nativePanel, moveDisabled = false, beforeMove, windowChrome = false, hideHeader = false }: {
  open: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode;
  defaultWidth?: number; minWidth?: number; adjacentMinWidth?: number; placement?: "right" | "bottom";
  headerContent?: ReactNode; headerActions?: ReactNode; resizable?: boolean; defaultHeight?: number; storageKey?: string;
  keepMounted?: boolean;
  nativePanel?: PanelTarget;
  moveDisabled?: boolean;
  beforeMove?: () => void;
  className?: string;
  defaultMaximized?: boolean;
  windowChrome?: boolean;
  /** A custom workbench can own its toolbar and close action. */
  hideHeader?: boolean;
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
  const [maximized, setMaximized] = useState(defaultMaximized);
  const [availableWidth,setAvailableWidth]=useState(window.innerWidth);
  // At the split-view breakpoint the panel may use its minimum width. As
  // space grows, reserve a usable conversation column before widening Git.
  const panelApi = getBridge()?.panels;
  const detached = !!(nativePanel && panelApi?.context);
  const [moving,setMoving] = useState(false);
  useEffect(()=>{
    if (!open || !nativePanel || !panelApi || detached) return;
    let disposed=false;
    void panelApi.open(nativePanel,true).then(focused=>{if(focused && !disposed)close.current();}).catch(()=>{});
    return ()=>{disposed=true;};
  },[open,panelApi,detached,nativePanel?.kind,nativePanel?.sessionId,nativePanel?.projectId]);
  const moveWindow = async () => {
    if (!nativePanel || !panelApi || moving || moveDisabled) return;
    setMoving(true);
    try {
      beforeMove?.();
      if (detached) await panelApi.dock();
      else if (await panelApi.open(nativePanel)) close.current();
    } catch(error) { toast.error(String(error)); }
    finally { setMoving(false); }
  };
  const moveLabel = detached ? (locale==="zh-CN"?"放回右侧":"Dock on the right") : (locale==="zh-CN"?"在独立窗口打开":"Open in separate window");
  const docked = availableWidth >= 850;
  const maxWidth = docked ? Math.max(Math.min(minWidth, availableWidth), availableWidth - adjacentMinWidth) : availableWidth;
  const remembered=useRememberedWidth(storageKey??"nautilo.workspace.width",defaultWidth,Math.min(minWidth,availableWidth),maxWidth);
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
  useEffect(()=>{
    if(!open||!resizable||placement!=="right")return;
    const parent=panel.current?.parentElement;if(!parent)return;
    const measure=():void=>{if(parent.clientWidth)setAvailableWidth(parent.clientWidth);};measure();
    const observer=new ResizeObserver(measure);observer.observe(parent);return()=>observer.disconnect();
  },[open,resizable,placement]);
  if (!open && !keepMounted) return null;
  return <aside ref={panel} tabIndex={-1} role="region" aria-label={title}
    aria-hidden={!open || undefined} hidden={!open}
    style={{...(placement === "right" ? { width: (detached||maximized)?"100%":resizable?remembered.width:`min(${defaultWidth}px, 100%)` } : adjustable && !maximized ? { height: renderedHeight } : {}),...(!open ? {display:"none"} : {})}}
    className={placement === "right" ? `workspace-panel-right ${resizable?"is-resizable":""} ${maximized?"is-maximized":""} z-30 flex max-w-full shrink-0 flex-col border-l border-line bg-panel outline-none ${className}` : `workspace-panel-bottom ${maximized ? "is-maximized" : ""} ${adjustable ? "is-resizable" : ""} relative z-20 flex shrink-0 flex-col border-t border-line bg-panel outline-none ${className}`}>
    {resizable&&!detached&&placement==="right"&&!maximized&&<ResizeHandle label={locale==="zh-CN"?`调整${title}宽度`:`Resize ${title}`} edge="left" value={remembered.width} min={Math.min(minWidth,availableWidth)} max={maxWidth} onChange={remembered.resize} onCommit={remembered.save} reset={defaultWidth}/>}
    {adjustable && !maximized && <div role="separator" tabIndex={0} aria-orientation="horizontal" aria-label={locale === "zh-CN" ? "调整终端高度" : "Resize terminal"}
      aria-valuemin={minHeight} aria-valuemax={maxHeight} aria-valuenow={renderedHeight} className="workspace-panel-resize"
      title={locale === "zh-CN" ? "拖动调整高度，双击最大化" : "Drag to resize, double-click to maximize"}
      onDoubleClick={() => setMaximized(true)}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { y: event.clientY, height: renderedHeight, cursor: document.body.style.cursor, userSelect: document.body.style.userSelect }; document.body.style.cursor = "ns-resize"; document.body.style.userSelect = "none"; }}
      onPointerMove={event => { if (drag.current) setHeight(clamp(drag.current.height + drag.current.y - event.clientY)); }}
      onPointerUp={event => { if (!drag.current) return; const next = clamp(drag.current.height + drag.current.y - event.clientY); setHeight(next); saveHeight(next); finishDrag(); event.currentTarget.releasePointerCapture(event.pointerId); }}
      onLostPointerCapture={finishDrag}
      onKeyDown={event => { const next = event.key === "ArrowUp" ? renderedHeight + 32 : event.key === "ArrowDown" ? renderedHeight - 32 : event.key === "Home" ? minHeight : event.key === "End" ? maxHeight : undefined; if (next === undefined) return; event.preventDefault(); const value = clamp(next); setHeight(value); saveHeight(value); }} />}
    {!hideHeader && <header className={windowChrome ? "browser-window-caption drag-region" : adjustable ? "workspace-panel-toolbar" : "flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3"}>
      {headerContent ?? <h2 className="text-sm font-medium" title={subtitle}>{title}</h2>}
      <div className="workspace-panel-actions no-drag">
        {headerActions}
        {!windowChrome && nativePanel && panelApi && <button type="button" className="workspace-panel-icon" title={moveLabel} aria-label={moveLabel} disabled={moving||moveDisabled} onClick={()=>void moveWindow()}>{detached?<PanelRightClose size={15}/>:<ExternalLink size={15}/>}</button>}
        {resizable && !detached && <button type="button" onClick={() => setMaximized(value => !value)} aria-label={locale === "zh-CN" ? (maximized ? `还原${adjustable?"终端":title}` : `最大化${adjustable?"终端":title}`) : (maximized ? `Restore ${adjustable?"terminal":title}` : `Maximize ${adjustable?"terminal":title}`)} title={locale === "zh-CN" ? (maximized ? "还原" : "最大化") : (maximized ? "Restore" : "Maximize")} className="workspace-panel-icon">
          {maximized ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
        </button>}
        {windowChrome ? <WindowControls /> : <button type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")} className="workspace-panel-icon"><X size={16} aria-hidden /></button>}
      </div>
    </header>}
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
  </aside>;
}
