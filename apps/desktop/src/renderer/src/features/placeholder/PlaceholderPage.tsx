import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { StatusChip } from "../../components/ui/Badge";
import { useI18n, type MessageKey } from "../../lib/i18n";

export function PlaceholderPage({
  icon: Icon,
  titleKey,
  descKey
}: {
  icon: LucideIcon;
  titleKey: MessageKey;
  descKey: MessageKey;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 220, damping: 24 }}
        className="relative flex max-w-md flex-col items-center px-8 py-12 text-center"
      >
        <div
          aria-hidden
          className="absolute inset-0 rounded-3xl border border-line bg-card/60 shadow-card backdrop-blur-sm"
        />
        <div className="relative mb-5">
          <div className="absolute -inset-4 rounded-full bg-accent-soft blur-2xl" aria-hidden />
          <motion.div
            animate={{ y: [0, -6, 0] }}
            transition={{ duration: 4, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}
            className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-accent/25 bg-accent-soft text-accent"
          >
            <Icon className="h-7 w-7" aria-hidden />
          </motion.div>
        </div>
        <div className="relative mb-2.5 flex items-center gap-2.5">
          <h1 className="text-lg font-semibold tracking-tight text-ink">{t(titleKey)}</h1>
          <StatusChip tone="accent" label={t("placeholder.badge")} />
        </div>
        <p className="relative text-sm leading-relaxed text-ink-3 text-balance">{t(descKey)}</p>
      </motion.div>
    </div>
  );
}
