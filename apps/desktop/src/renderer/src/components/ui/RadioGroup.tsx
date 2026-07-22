import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface RadioCardItem {
  value: string;
  label: string;
  description?: string;
  preview?: ReactNode;
}

export function RadioCardGroup({
  value,
  onValueChange,
  items,
  "aria-label": ariaLabel
}: {
  value: string;
  onValueChange: (value: string) => void;
  items: RadioCardItem[];
  "aria-label"?: string;
}): JSX.Element {
  return (
    <RadioGroupPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      aria-label={ariaLabel}
      className="grid grid-cols-1 gap-3 sm:grid-cols-3"
    >
      {items.map((item) => (
        <RadioGroupPrimitive.Item
          key={item.value}
          value={item.value}
          className={cn(
            "group flex flex-col items-start gap-2 rounded-xl border border-line bg-card p-3.5 text-left outline-none transition-all duration-150",
            "hover:border-accent/40 hover:bg-card-hover",
            "focus-visible:ring-2 focus-visible:ring-accent/70",
            "data-[state=checked]:border-accent/60 data-[state=checked]:bg-accent-soft/60 data-[state=checked]:shadow-glow"
          )}
        >
          {item.preview}
          <div className="flex w-full items-center justify-between gap-2">
            <span className="text-sm font-medium text-ink">{item.label}</span>
            <span
              aria-hidden
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded-full border border-line-strong transition-colors",
                "group-data-[state=checked]:border-accent group-data-[state=checked]:bg-accent"
              )}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-white opacity-0 transition-opacity group-data-[state=checked]:opacity-100" />
            </span>
          </div>
          {item.description && <span className="text-xs text-ink-3">{item.description}</span>}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}
