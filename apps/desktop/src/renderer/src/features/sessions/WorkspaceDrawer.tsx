import { useEffect, useRef, type ReactNode } from "react";
import "./workspace-panels.css";
import { X } from "lucide-react";
import { useI18n } from "../../lib/i18n";

/** Contextual, non-modal workspace panel: chat and its controls stay available. */
export function WorkspaceDrawer({ open, onClose, title, subtitle, children, defaultWidth = 580, placement = "right" }: {
  open: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode;
  defaultWidth?: number; minWidth?: number; placement?: "right" | "bottom";
}): JSX.Element | null {
  const { t } = useI18n();
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && panel.current?.contains(document.activeElement)) { event.stopPropagation(); close.current(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [open]);
  if (!open) return null;
  return <aside ref={panel} tabIndex={-1} role="region" aria-label={title} style={placement === "right" ? { width: `min(${defaultWidth}px, 100%)` } : undefined} className={placement === "right" ? "workspace-panel-right z-30 flex max-w-full shrink-0 flex-col border-l border-line bg-panel outline-none" : "relative z-20 flex h-[40%] min-h-40 max-h-[50%] shrink-0 flex-col border-t border-line bg-panel outline-none"}>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
      <h2 className="text-sm font-medium" title={subtitle}>{title}</h2>
      <button type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")} className="rounded-lg p-2 text-ink-3 hover:bg-card-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"><X className="h-4 w-4" aria-hidden /></button>
    </header>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
  </aside>;
}
