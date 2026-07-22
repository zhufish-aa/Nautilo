import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useToastStore, type ToastKind } from "../../stores/toast";
import { cn } from "../../lib/utils";

const kindStyles: Record<ToastKind, { icon: typeof Info; bar: string; iconColor: string }> = {
  success: { icon: CheckCircle2, bar: "bg-ok", iconColor: "text-ok" },
  error: { icon: AlertCircle, bar: "bg-danger", iconColor: "text-danger" },
  info: { icon: Info, bar: "bg-info", iconColor: "text-info" }
};

export function Toaster(): JSX.Element {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toastItem) => {
          const style = kindStyles[toastItem.kind];
          const Icon = style.icon;
          return (
            <motion.div
              key={toastItem.id}
              layout
              initial={{ opacity: 0, x: 48, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 32, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              className="pointer-events-auto relative flex items-center gap-3 overflow-hidden rounded-xl border border-line bg-card py-3 pr-3 pl-4 shadow-pop"
            >
              <span aria-hidden className={cn("absolute inset-y-0 left-0 w-0.5", style.bar)} />
              <Icon className={cn("h-4.5 w-4.5 shrink-0", style.iconColor)} aria-hidden />
              <p className="min-w-0 flex-1 text-[13px] leading-snug text-ink">{toastItem.message}</p>
              <button
                onClick={() => dismiss(toastItem.id)}
                className="rounded-md p-1 text-ink-3 transition-colors hover:bg-accent-soft hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
