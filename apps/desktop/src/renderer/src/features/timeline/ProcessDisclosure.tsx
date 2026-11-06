import { useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import "./ProcessDisclosure.css";

export function ProcessDisclosure({ icon, label, preview, open, onToggle, running, failed, children, className = "", retainPreview = false }: {
  icon: ReactNode; label: string; preview?: string; open: boolean; onToggle: () => void;
  running?: boolean; failed?: boolean; children?: ReactNode; className?: string;
  retainPreview?: boolean;
}): JSX.Element {
  const contentId = useId();
  return <div className={`process-disclosure ${className}`} data-open={open || undefined} data-running={running || undefined} data-failed={failed || undefined}>
    <button type="button" className="process-disclosure-row" aria-expanded={open} aria-controls={contentId} onClick={onToggle}>
      <span className="process-disclosure-leading" aria-hidden>{open ? <ChevronDown size={14} className="rotate-180" /> : icon}</span>
      <span className="process-disclosure-label">{label}</span>
      {(!open || retainPreview) && preview && <><span className="process-disclosure-dot" aria-hidden>·</span><span className="process-disclosure-preview" title={preview}>{preview}</span></>}
      <ChevronDown size={12} className="process-disclosure-chevron" aria-hidden />
    </button>
    {open && <div id={contentId} className="process-disclosure-body">{children}</div>}
  </div>;
}
