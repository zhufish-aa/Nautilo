import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export function SelectField({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  "aria-label": ariaLabel,
  className
}: {
  value?: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}): JSX.Element {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          "flex h-9.5 w-full items-center justify-between gap-2 rounded-xl border border-line-strong bg-card px-3 text-sm text-ink outline-none transition-colors",
          "hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/70",
          "disabled:cursor-not-allowed disabled:opacity-45 data-[placeholder]:text-ink-3",
          className
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} className="min-w-0 truncate [&_.select-hint]:hidden [&_span]:truncate" />
        <SelectPrimitive.Icon>
          <ChevronDown className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className={cn(
            "z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-line bg-card shadow-pop",
            "data-[state=open]:animate-pop-in"
          )}
        >
          <SelectPrimitive.Viewport className="p-1.5">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  "relative flex cursor-pointer select-none items-center rounded-lg py-2 pr-8 pl-3 text-sm text-ink outline-none",
                  "data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent",
                  "data-[state=checked]:font-medium",
                  "data-[disabled]:pointer-events-none data-[disabled]:opacity-45"
                )}
              >
                <SelectPrimitive.ItemText>
                  <span className="block truncate">{option.label}</span>
                  {option.hint && <span className="select-hint block truncate text-xs text-ink-3">{option.hint}</span>}
                </SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2.5 text-accent">
                  <Check className="h-4 w-4" aria-hidden />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
