import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface TabItem {
  value: string;
  label: string;
  count?: number;
}

export function Tabs({
  items,
  value,
  onValueChange,
  "aria-label": ariaLabel,
  className
}: {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  "aria-label"?: string;
  className?: string;
}): JSX.Element {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange} className={className}>
      <TabsPrimitive.List
        aria-label={ariaLabel}
        className="ui-tabs inline-flex h-10 items-center gap-1 rounded-xl border border-line bg-card p-1"
      >
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium text-ink-3 outline-none transition-all duration-150",
              "hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/70",
              "data-[state=active]:bg-accent-soft data-[state=active]:text-accent data-[state=active]:shadow-[inset_0_0_0_1px_var(--accent-soft)]"
            )}
          >
            {item.label}
            {item.count !== undefined && (
              <span className="rounded-md bg-line/60 px-1.5 py-0.5 text-[11px] leading-none text-ink-3 data-[state=active]:text-accent">
                {item.count}
              </span>
            )}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

/** Lightweight tab bar without Radix Root — for dialogs that manage their own panels. */
export function TabBar({
  items,
  value,
  onValueChange,
  "aria-label": ariaLabel
}: {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  "aria-label"?: string;
}): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="ui-tabs inline-flex h-10 items-center gap-1 rounded-xl border border-line bg-card p-1"
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onValueChange(item.value)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium outline-none transition-all duration-150",
              "focus-visible:ring-2 focus-visible:ring-accent/70",
              active ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink"
            )}
          >
            {item.label}
            {item.count !== undefined && (
              <span
                className={cn(
                  "rounded-md px-1.5 py-0.5 text-[11px] leading-none",
                  active ? "bg-accent/15 text-accent" : "bg-line/60 text-ink-3"
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  value,
  activeValue,
  children,
  className
}: {
  value: string;
  activeValue: string;
  children: ReactNode;
  className?: string;
}): JSX.Element | null {
  if (value !== activeValue) return null;
  return (
    <div role="tabpanel" className={className}>
      {children}
    </div>
  );
}
