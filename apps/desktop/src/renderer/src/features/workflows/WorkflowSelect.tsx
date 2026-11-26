import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import type { PropsWithChildren } from "react";

interface Choice {
  value: string;
  label: string;
  disabled?: boolean;
}

export function workflowChoices(labels: Record<string, string>): Choice[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}

export function WorkflowSelect({ label, value, options, onChange, placeholder, disabled, children }: PropsWithChildren<{
  label: string;
  value?: string;
  options: Choice[];
  onChange(value: string): void;
  placeholder?: string;
  disabled?: boolean;
}>) {
  const selected = options.find(option => option.value === value);
  return <Menu.Root modal={false}>
    <Menu.Trigger type="button" className="wf-select" aria-label={label} disabled={disabled}>
      <span>{selected?.label ?? placeholder ?? "请选择"}</span><ChevronDown size={13} aria-hidden/>
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Content className="wf-select-popover" aria-label={label} align="start" sideOffset={5} collisionPadding={10}>
        <Menu.RadioGroup value={value} onValueChange={onChange}>
          {options.map(option => <Menu.RadioItem key={option.value} value={option.value} data-choice={option.value} disabled={option.disabled} className="wf-select-option">
            <Menu.ItemIndicator className="wf-select-check"><Check size={13} aria-hidden/></Menu.ItemIndicator>
            <span>{option.label}</span>
          </Menu.RadioItem>)}
        </Menu.RadioGroup>
        {children}
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
}

export function WorkflowSegments<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; count?: number; warning?: boolean }>;
  onChange(value: T): void;
}) {
  const active = options.findIndex(option => option.value === value);
  return <div className="wf-segments" role="group" aria-label={label} style={{ "--wf-segments": options.length, "--wf-segment": active } as React.CSSProperties}>
    <span className="wf-segment-indicator" aria-hidden/>
    {options.map((option, index) => <button key={option.value} type="button" aria-pressed={option.value === value} data-warning={option.warning || undefined}
      onClick={() => onChange(option.value)} onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = (index + options.length + (event.key === "ArrowLeft" ? -1 : 1)) % options.length;
        onChange(options[next].value);
        event.currentTarget.parentElement?.querySelectorAll("button")[next]?.focus();
      }}>
      {option.label}{option.count !== undefined && <small>{option.count}</small>}
    </button>)}
  </div>;
}
