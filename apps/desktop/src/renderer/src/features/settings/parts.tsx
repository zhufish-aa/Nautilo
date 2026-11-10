import { HelpCircle, type LucideIcon } from "lucide-react";
import { Tooltip } from "../../components/ui/Tooltip";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** Shared header for settings cards: icon chip + title/description + right-aligned actions. */
export function SectionHeader({
  icon: Icon,
  title,
  description,
  actions,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-3",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-ink-3">
          <Icon className="h-4.5 w-4.5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-ink">
            {title}
            {description && (
              <Tooltip content={description}>
                <button
                  type="button"
                  aria-label={description}
                  className="rounded text-ink-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <HelpCircle className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            )}
          </h2>
        </div>
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
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
  children,
}: {
  icon?: LucideIcon;
  title?: string;
  count?: number;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section
      className={cn("rounded-lg border border-line bg-card p-4", className)}
    >
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && (
            <h3 className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-ink">
              {Icon && (
                <Icon className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
              )}
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
