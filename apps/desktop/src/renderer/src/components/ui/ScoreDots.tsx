import { cn } from "../../lib/utils";

/** 1–5 dot rating used for capability strengths (F-012). */
export function ScoreDots({
  value,
  onChange,
  "aria-label": ariaLabel
}: {
  value: number;
  onChange?: (value: number) => void;
  "aria-label"?: string;
}): JSX.Element {
  const readonly = !onChange;
  return (
    <div
      role={readonly ? "img" : "radiogroup"}
      aria-label={ariaLabel}
      className="inline-flex items-center gap-1"
    >
      {[1, 2, 3, 4, 5].map((score) => {
        const active = score <= value;
        const dot = (
          <span
            className={cn(
              "h-2.5 w-2.5 rounded-full transition-all duration-150",
              active ? "bg-gradient-to-br from-accent to-accent-2 shadow-[0_0_8px_-1px_var(--accent)]" : "bg-line-strong",
              !readonly && "group-hover/dot:scale-125"
            )}
          />
        );
        if (readonly) return <span key={score}>{dot}</span>;
        return (
          <button
            key={score}
            type="button"
            role="radio"
            aria-checked={score === value}
            aria-label={`${score}`}
            onClick={() => onChange(score === value ? 0 : score)}
            className="group/dot rounded p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            {dot}
          </button>
        );
      })}
    </div>
  );
}
