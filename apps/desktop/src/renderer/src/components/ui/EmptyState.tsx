import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 220, damping: 24 }}
      className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong bg-card/50 px-8 py-16 text-center"
    >
      <div className="relative mb-5">
        <div className="absolute -inset-3 rounded-full bg-accent-soft blur-xl" aria-hidden />
        <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/25 bg-accent-soft text-accent">
          <Icon className="h-6 w-6" aria-hidden />
        </div>
      </div>
      <h3 className="text-base font-semibold text-ink text-balance">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-ink-3 text-balance">{description}</p>
      {action && <div className="mt-6">{action}</div>}
    </motion.div>
  );
}
