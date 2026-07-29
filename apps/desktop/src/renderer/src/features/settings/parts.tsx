import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** Shared header for settings cards: icon chip + title/description + right-aligned actions. */
export function SectionHeader({
  icon: Icon,
  title,
  description,
  actions,
  className
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-gradient-to-br from-accent/25 to-accent/5 text-accent">
          <Icon className="h-4.5 w-4.5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Sub-section panel inside a settings card, with an optional titled header row. */
export function Panel({
  icon: Icon,
  title,
  count,
  actions,
  className,
  children
}: {
  icon?: LucideIcon;
  title?: string;
  count?: number;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={cn("rounded-xl border border-line bg-card-hover/40 p-3.5", className)}>
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && (
            <h3 className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-ink">
              {Icon && <Icon className="h-4 w-4 shrink-0 text-accent" aria-hidden />}
              <span className="truncate">{title}</span>
              {typeof count === "number" && (
                <span className="shrink-0 rounded-full border border-line bg-card px-1.5 text-[10px] leading-4 font-medium text-ink-3">
                  {count}
                </span>
              )}
            </h3>
          )}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** Compact dashed placeholder for empty lists inside panels. */
export function EmptyHint({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="rounded-lg border border-dashed border-line-strong px-3 py-5 text-center text-xs text-ink-3">
      {children}
    </p>
  );
}
