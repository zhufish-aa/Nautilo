import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useUiReducedMotion } from "../../lib/ui-motion";
import "./ProcessDisclosure.css";

export function ProcessDisclosure({ icon, label, badge, preview, previewTitle, accessory, monospace, open, onToggle, running, failed, children, className = "", retainPreview = false, followPreviewTail = false }: {
  icon?: ReactNode; label?: string; badge?: string; preview?: ReactNode; previewTitle?: string; accessory?: ReactNode; monospace?: boolean; open: boolean; onToggle?: () => void;
  running?: boolean; failed?: boolean; children?: ReactNode; className?: string;
  retainPreview?: boolean; followPreviewTail?: boolean;
}): JSX.Element {
  const contentId = useId();
  const reducedMotion = useUiReducedMotion();
  const active = running && !failed;
  const [retained, setRetained] = useState(open);
  const trigger = useRef<HTMLButtonElement>(null);
  const fold = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!open && clip.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
    if (clip.current) clip.current.inert = !open;
    if (open) { if (!retained) setRetained(true); return; }
    if (!retained) return;
    if (reducedMotion || !fold.current?.offsetHeight) { setRetained(false); return; }
    const duration = Number.parseFloat(getComputedStyle(fold.current).getPropertyValue("--conversation-detail-duration"));
    const timeout = window.setTimeout(() => setRetained(false), (duration || 220) + 50);
    return () => window.clearTimeout(timeout);
  }, [open, reducedMotion, retained]);
  useLayoutEffect(() => {
    const node = previewRef.current;
    if (followPreviewTail && node) node.scrollLeft = node.scrollWidth;
  }, [preview, followPreviewTail, open]);
  useLayoutEffect(() => {
    const node = previewRef.current;
    if (!followPreviewTail || !node) return;
    const observer = new ResizeObserver(() => { node.scrollLeft = node.scrollWidth; });
    observer.observe(node);
    return () => observer.disconnect();
  }, [followPreviewTail, open, Boolean(preview)]);
  return <div className={`process-disclosure ${className}`} data-open={open || undefined} data-running={active || undefined} data-failed={failed || undefined} data-reduced={reducedMotion || undefined}>
    {label && <div className="process-disclosure-row">
      <span className="conversation-step-icon process-disclosure-leading" data-activity-mark={active || undefined} aria-hidden>{icon}</span>
      <span className="process-disclosure-label" title={label} data-activity-sweep={active && !reducedMotion ? label : undefined}>{label}</span>
      {badge && <span className="process-disclosure-badge">{badge}</span>}
      {(!open || retainPreview) && preview && <><span className="process-disclosure-dot" aria-hidden>·</span><span ref={previewRef} className="process-disclosure-preview" data-monospace={monospace || undefined} data-follow-tail={followPreviewTail || undefined} title={previewTitle ?? (typeof preview === "string" ? preview : undefined)}>{preview}</span></>}
      {accessory && <span className="process-disclosure-accessory">{accessory}</span>}
      {onToggle && <button ref={trigger} type="button" className="process-disclosure-trigger"
        aria-label={previewTitle ? label + " " + previewTitle : label}
        aria-expanded={open} aria-controls={contentId} onClick={onToggle}>
        <ChevronRight size={13} className="process-disclosure-chevron" aria-hidden />
      </button>}
    </div>}
    <div ref={fold} id={contentId} className="process-disclosure-fold" aria-hidden={!open || undefined}
      onTransitionEnd={event => {
        if (!open && event.target === event.currentTarget && event.propertyName === "grid-template-rows") setRetained(false);
      }}>
      <div ref={clip} className="process-disclosure-clip">
        {(open || retained) && <div className="process-disclosure-body">{children}</div>}
      </div>
    </div>
  </div>;
}
