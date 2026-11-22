import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { UI_EASE_OUT, useUiReducedMotion } from "../../lib/ui-motion";

interface StageActivity {
  id: string;
  label: string;
  startedAt?: number;
}

function ActivityTime({ startedAt }: { startedAt: number }): JSX.Element {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <span className="stage-activity-time" aria-hidden>{elapsed}</span>;
}

/** Shows live activity while preserving the existing runtime lifecycle. */
export function StageActivityPill({ activity, completed }: {
  activity?: StageActivity;
  completed?: readonly string[];
}): JSX.Element {
  const reduced = useUiReducedMotion();
  const succeeded = (ids?: readonly string[]): boolean => !!activity && !!ids?.includes(activity.id);
  const transition = { duration: reduced ? 0 : 0.2, ease: UI_EASE_OUT };
  return <AnimatePresence custom={completed}>
    {activity && <motion.div key="stage-activity" className="stage-activity-pill" role="status"
      initial={reduced ? false : "enter"} animate="visible" exit="exit" transition={transition}
      variants={{
        enter: { opacity: 0, transform: "translateY(-5px) scale(.98)" },
        visible: { opacity: 1, transform: "translateY(0) scale(1)" },
        exit: (ids?: readonly string[]) => succeeded(ids) && !reduced
          ? { opacity: [1, 1, 0], transform: ["translateY(0)", "translateY(0)", "translateY(-4px)"], transition: { ...transition, duration: 0.46, times: [0, 0.45, 1] } }
          : { opacity: 0, transform: reduced ? "none" : "translateY(-4px)" }
      }}>
      <span className="stage-activity-edge" aria-hidden />
      <motion.span className="stage-activity-success" aria-hidden
        variants={{ enter: { opacity: 0 }, visible: { opacity: 0 }, exit: (ids?: readonly string[]) => succeeded(ids) && !reduced
          ? { opacity: [0, 1, 0], transition: { ...transition, duration: 0.46, times: [0, 0.34, 1] } }
          : { opacity: 0 } }} />
      <span className="stage-activity-dot" aria-hidden />
      <span className="stage-activity-label">{activity.label}</span>
      {activity.startedAt !== undefined && Number.isFinite(activity.startedAt) && <ActivityTime startedAt={activity.startedAt} />}
    </motion.div>}
  </AnimatePresence>;
}
