import { cn } from "../../lib/utils";

export type ChipTone = "ok" | "warn" | "danger" | "info" | "muted" | "accent";

const toneClasses: Record<ChipTone, { chip: string; dot: string }> = {
  ok: {
    chip: "border-ok/25 bg-ok/10 text-ok",
    dot: "bg-ok"
  },
  warn: {
    chip: "border-warn/25 bg-warn/10 text-warn",
    dot: "bg-warn"
  },
  danger: {
    chip: "border-danger/25 bg-danger/10 text-danger",
    dot: "bg-danger"
  },
  info: {
    chip: "border-info/25 bg-info/10 text-info",
    dot: "bg-info"
  },
  muted: {
    chip: "border-line-strong bg-card-hover text-ink-3",
    dot: "bg-ink-3"
  },
  accent: {
    chip: "border-accent/25 bg-accent-soft text-accent",
    dot: "bg-accent"
  }
};

export function StatusChip({
  tone,
  label,
  pulse,
  className
}: {
  tone: ChipTone;
  label: string;
  pulse?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        "ui-chip inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap",
        toneClasses[tone].chip,
        className
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        {pulse && (
          <span
            aria-hidden
            className={cn(
              "absolute inline-flex h-full w-full rounded-full opacity-70",
              toneClasses[tone].dot,
              "motion-safe:animate-[pulse-ring_1.6s_ease-out_infinite]"
            )}
          />
        )}
        <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", toneClasses[tone].dot)} />
      </span>
      {label}
    </span>
  );
}

export function Tag({
  label,
  className,
  title
}: {
  label: string;
  className?: string;
  title?: string;
}): JSX.Element {
  return (
    <span
      title={title ?? label}
      className={cn(
        "ui-tag inline-flex h-6 max-w-full items-center rounded-md border border-line bg-card-hover px-2 text-xs break-all text-ink-2",
        className
      )}
    >
      {label}
    </span>
  );
}
