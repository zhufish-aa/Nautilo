import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export function InspectorDisclosure({ label, closedLabel, summary, defaultOpen = true, triggerAfter = false, className = "", children }: {
  label: string;
  closedLabel?: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  triggerAfter?: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const trigger = <button type="button" className="session-inspector-section-heading" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
    <ChevronRight size={13} aria-hidden /><span>{open ? label : closedLabel ?? label}</span>{summary}
  </button>;
  return <section className={`session-inspector-disclosure ${className}`}>
    {!triggerAfter && trigger}
    <div id={id} className="session-inspector-disclosure-body" data-expanded={open} aria-hidden={!open} ref={node => { if (node) node.inert = !open; }}>
      <div>{children}</div>
    </div>
    {triggerAfter && trigger}
  </section>;
}
