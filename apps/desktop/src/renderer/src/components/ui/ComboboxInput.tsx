import { ChevronDown, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "./Input";
import { cn } from "../../lib/utils";

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
  badge?: string;
}

/** Editable picker: catalog values are convenient, but arbitrary provider model IDs remain valid. */
export function ComboboxInput({
  id,
  value,
  onChange,
  options,
  placeholder,
  loading,
  className
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  loading?: boolean;
  className?: string;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const query = value.trim().toLocaleLowerCase();
  const filtered = useMemo(() => {
    if (!query) return options;
    return options.filter((option) =>
      `${option.label} ${option.value}`.toLocaleLowerCase().includes(query)
    );
  }, [options, query]);

  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div ref={rootRef} className="relative">
      <Input
        id={id}
        value={value}
        onFocus={() => setOpen(true)}
        onChange={(event) => { onChange(event.target.value); setOpen(true); }}
        onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={cn("pr-10", className)}
      />
      <button
        type="button"
        aria-label="Toggle model options"
        onClick={() => setOpen((current) => !current)}
        className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-lg p-1.5 text-ink-3 hover:bg-accent-soft hover:text-accent"
      >
        {loading ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
      </button>
      {open && filtered.length > 0 && (
        <div className="absolute z-60 mt-1.5 max-h-56 w-full overflow-y-auto rounded-xl border border-line bg-card p-1.5 shadow-pop">
          {filtered.map((option) => (
            <button
              key={option.value}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { onChange(option.value); setOpen(false); }}
              className="flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink-2">{option.label}</span>
                <span className="block truncate font-mono text-[11px] text-ink-3">{option.value}</span>
                {option.description && <span className="mt-0.5 block line-clamp-2 text-[11px] text-ink-3">{option.description}</span>}
              </span>
              {option.badge && <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">{option.badge}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
