import { AnimatePresence, motion } from "framer-motion";
import { Clock, Undo2 } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { cancelWorkbenchFollowUp } from "../../lib/orchestration-runtime";
import { useSessionsStore } from "../../stores/sessions";
import { toast } from "../../stores/toast";
import { StatusChip } from "../../components/ui/Badge";

/**
 * Queued follow-ups for the active session, shown above the composer. Sourced
 * from the daemon queue (session.followUp.list + queue events); each entry
 * can be withdrawn while it is still waiting.
 */
export function QueuedFollowUpBar({ sessionId }: { sessionId: string }): JSX.Element | null {
  const { t } = useI18n();
  const items = useSessionsStore((state) => state.queuedFollowUps[sessionId]);

  const withdraw = (messageId: string): void => {
    void cancelWorkbenchFollowUp(sessionId, messageId).catch(() => {
      toast.error(t("sessions.queue.cancelFailed"));
    });
  };

  if (!items?.length) return null;
  return (
    <div className="shrink-0 border-t border-line/80 bg-panel/60 px-5 pt-2.5 backdrop-blur-xl" aria-label={t("sessions.queue.title")}>
      <ul className="mx-auto flex w-full max-w-4xl flex-col gap-1.5">
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.li
              key={item.messageId}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="flex items-center gap-2 overflow-hidden rounded-lg border border-line bg-card px-2.5 py-1.5"
            >
              <Clock className="h-3.5 w-3.5 shrink-0 text-warn" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs text-ink-2" title={item.text}>
                {item.text}
              </span>
              <StatusChip tone="warn" label={t("sessions.queue.badge")} className="h-5 shrink-0 px-1.5 text-[10px]" />
              <button
                type="button"
                onClick={() => withdraw(item.messageId)}
                className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-ink-3 transition-colors hover:bg-danger/10 hover:text-danger focus-visible:ring-2 focus-visible:ring-danger/60 focus-visible:outline-none"
              >
                <Undo2 className="h-3 w-3" aria-hidden />
                {t("sessions.queue.cancel")}
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}
