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
  description?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="flex flex-col items-center justify-center rounded-xl bg-transparent px-8 py-16 text-center"
    >
      <div className="mb-4 flex h-10 w-10 items-center justify-center text-ink-3"><Icon className="h-6 w-6" strokeWidth={1.5} aria-hidden /></div>
      <h3 className="text-base font-semibold text-ink text-balance">{title}</h3>
      {description && <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-3 text-balance">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </motion.div>
  );
}
