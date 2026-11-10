import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CornerDownRight, ListEnd, Loader2, Trash2 } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { cancelWorkbenchFollowUp, steerWorkbenchQueuedFollowUp } from "../../lib/orchestration-runtime";
import { useSessionsStore } from "../../stores/sessions";
import { toast } from "../../stores/toast";
import { UI_EASE_OUT, useUiReducedMotion } from "../../lib/ui-motion";

/** Pending turns keep their original identity when promoted to guidance. */
export function QueuedFollowUpBar({ sessionId, disabled }: { sessionId: string; disabled?: boolean }): JSX.Element | null {
  const { t } = useI18n();
  const reducedMotion = useUiReducedMotion();
  const items = useSessionsStore((state) => state.queuedFollowUps[sessionId]);
  const pending = useRef(new Set<string>());
  const [busyIds, setBusyIds] = useState(new Set<string>());

  const act = async (messageId: string, action: "steer" | "remove"): Promise<void> => {
    if (disabled || pending.current.has(messageId)) return;
    pending.current.add(messageId);
    setBusyIds(new Set(pending.current));
    try {
      if (action === "remove") await cancelWorkbenchFollowUp(sessionId, messageId);
      else if (await steerWorkbenchQueuedFollowUp(sessionId, messageId) === "queue") toast.info(t("sessions.queue.steerUnavailable"));
    } catch {
      toast.error(t(action === "remove" ? "sessions.queue.cancelFailed" : "sessions.queue.steerFailed"));
    } finally {
      pending.current.delete(messageId);
      setBusyIds(new Set(pending.current));
    }
  };

  return (
    <AnimatePresence initial={false}>
      {!!items?.length && <motion.div key="pending-inputs"
        initial={{ opacity: 0, transform: "translateY(5px)" }}
        animate={{ opacity: 1, transform: "translateY(0px)" }}
        exit={{ opacity: 0, transform: "translateY(-4px)" }}
        transition={{ duration: reducedMotion ? 0 : 0.14, ease: UI_EASE_OUT }}>
    <div className="composer-queue mx-auto w-full px-3" aria-label={t("sessions.queue.title")}>
      <ul className="max-h-40 overflow-y-auto rounded-t-2xl border border-b-0 border-line bg-panel/50 px-2 py-1">
        {items.map((item) => (
          <li key={item.messageId} className="flex min-h-8 items-center gap-2 px-1.5 py-1">
            <ListEnd className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={item.text}>{item.text}</span>
            <button type="button" disabled={disabled || busyIds.has(item.messageId)} onClick={() => void act(item.messageId, "steer")}
              title={t("sessions.composer.steerTitle")} className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-ink-2 transition-colors hover:bg-card-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40">
              {busyIds.has(item.messageId) ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <CornerDownRight className="h-3.5 w-3.5" aria-hidden />}
              {t("sessions.composer.steer")}
            </button>
            <button type="button" disabled={disabled || busyIds.has(item.messageId)} onClick={() => void act(item.messageId, "remove")}
              title={t("common.remove")} aria-label={t("common.remove")}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-card-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40">
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
      </motion.div>}
    </AnimatePresence>
  );
}
