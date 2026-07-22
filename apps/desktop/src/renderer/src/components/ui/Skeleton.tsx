import { cn } from "../../lib/utils";

export function Skeleton({ className }: { className?: string }): JSX.Element {
  return <div aria-hidden className={cn("animate-shimmer rounded-lg bg-card-hover", className)} />;
}

export function SkeletonCard(): JSX.Element {
  return (
    <div className="rounded-2xl border border-line bg-card p-5 shadow-card" aria-hidden>
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
      <div className="mt-4 space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    </div>
  );
}
