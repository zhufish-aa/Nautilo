import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

export function TagInput({
  values,
  onChange,
  placeholder,
  "aria-label": ariaLabel
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  "aria-label"?: string;
}): JSX.Element {
  const [draft, setDraft] = useState("");

  const commit = (): void => {
    const value = draft.trim();
    if (!value) return;
    if (!values.includes(value)) onChange([...values, value]);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && draft === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div
      className={cn(
        "flex min-h-9.5 w-full flex-wrap items-center gap-1.5 rounded-xl border border-line-strong bg-card px-2 py-1.5 transition-colors",
        "hover:border-accent/40 focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/25"
      )}
    >
      {values.map((value) => (
        <span
          key={value}
          className="inline-flex h-6.5 items-center gap-1 rounded-lg border border-accent/20 bg-accent-soft px-2 font-mono text-xs text-accent"
        >
          {value}
          <button
            type="button"
            aria-label={`${value}`}
            onClick={() => onChange(values.filter((item) => item !== value))}
            className="rounded p-0.5 text-accent/70 transition-colors hover:text-accent focus-visible:ring-1 focus-visible:ring-accent/70 focus-visible:outline-none"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        placeholder={values.length === 0 ? placeholder : undefined}
        aria-label={ariaLabel}
        className="h-6.5 min-w-28 flex-1 bg-transparent font-mono text-xs text-ink outline-none placeholder:font-sans placeholder:text-ink-3/70"
      />
    </div>
  );
}
