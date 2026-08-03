import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useI18n } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { Button } from "../../components/ui/Button";
import { ONBOARDING_STEPS } from "./steps";

const SPOTLIGHT_PADDING = 8;
const CARD_WIDTH = 320;
/** Rough card height used to pick above/below placement. */
const CARD_HEIGHT = 230;
/** How long to poll for a step's target after navigation (ms). */
const TARGET_POLL_TIMEOUT = 2000;

/** Spotlight target rect, or null when the element is missing/hidden/off-screen. */
function resolveTargetRect(selector: string): DOMRect | null {
  const el = document.querySelector(selector);
  if (!el || el.getClientRects().length === 0) return null;
  const style = window.getComputedStyle(el);
  // The keep-alive workbench panes stay mounted with visibility:hidden.
  if (style.visibility === "hidden" || style.display === "none") return null;
  const rect = el.getBoundingClientRect();
  const inViewport =
    rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  return inViewport ? rect : null;
}

/**
 * First-run guided tour: a spotlight cutout over the step target plus a small
 * explanation card. Rendered until the user finishes or skips; the flag lives
 * in the persisted settings store so it only shows once.
 */
export function OnboardingTour(): JSX.Element | null {
  const { t } = useI18n();
  const completed = useSettingsStore((state) => state.onboardingCompleted);
  const setOnboardingCompleted = useSettingsStore((state) => state.setOnboardingCompleted);
  const reduceMotion = useSettingsStore((state) => state.reduceMotion);
  const navigate = useNavigate();
  const location = useLocation();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const step = ONBOARDING_STEPS[index];
  const isLast = index === ONBOARDING_STEPS.length - 1;

  // Restart from the first step when the tour is re-enabled from Settings.
  useEffect(() => {
    if (!completed) setIndex(0);
  }, [completed]);

  // Bring the app to the page the current step talks about.
  useEffect(() => {
    if (completed || !step.path || location.pathname === step.path) return;
    navigate(step.path);
  }, [completed, step, location.pathname, navigate]);

  // Resolve the spotlight target: the page mounts asynchronously after
  // navigation, so poll briefly and fall back to a centered card.
  useEffect(() => {
    if (completed) return;
    if (!step.target) {
      setRect(null);
      return;
    }
    const selector = step.target;
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();

    const poll = (): void => {
      if (cancelled) return;
      const found = resolveTargetRect(selector);
      if (found) {
        setRect(found);
        return;
      }
      if (Date.now() - startedAt < TARGET_POLL_TIMEOUT) {
        timer = window.setTimeout(poll, 100);
      } else {
        setRect(null);
      }
    };
    poll();

    const remeasure = (): void => {
      if (!cancelled) setRect(resolveTargetRect(selector));
    };
    window.addEventListener("resize", remeasure);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("resize", remeasure);
    };
  }, [completed, step]);

  if (completed) return null;

  const finish = (): void => setOnboardingCompleted(true);

  // Below the target when it fits, otherwise above; centered steps go
  // straight to the screen center. Horizontal position is clamped on-screen.
  const cardPos = rect
    ? {
        top:
          rect.bottom + SPOTLIGHT_PADDING + 12 + CARD_HEIGHT < window.innerHeight
            ? rect.bottom + SPOTLIGHT_PADDING + 12
            : Math.max(16, rect.top - SPOTLIGHT_PADDING - 12 - CARD_HEIGHT),
        left: Math.min(
          Math.max(16, rect.left + rect.width / 2 - CARD_WIDTH / 2),
          window.innerWidth - CARD_WIDTH - 16
        )
      }
    : {
        top: Math.max(16, (window.innerHeight - CARD_HEIGHT) / 2),
        left: Math.max(16, (window.innerWidth - CARD_WIDTH) / 2)
      };

  const transition = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 320, damping: 30 };

  return (
    <div className="fixed inset-0 z-[80]" role="presentation">
      {rect ? (
        <motion.div
          key={`spotlight-${step.id}`}
          initial={false}
          animate={{
            top: rect.top - SPOTLIGHT_PADDING,
            left: rect.left - SPOTLIGHT_PADDING,
            width: rect.width + SPOTLIGHT_PADDING * 2,
            height: rect.height + SPOTLIGHT_PADDING * 2
          }}
          transition={transition}
          className="pointer-events-none fixed rounded-xl border-2 border-accent shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
        />
      ) : (
        <div className="absolute inset-0 bg-black/55" />
      )}

      <motion.div
        key={`card-${step.id}`}
        role="dialog"
        aria-label={t(step.titleKey)}
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1, top: cardPos.top, left: cardPos.left }}
        transition={transition}
        className="fixed flex w-80 flex-col gap-4 rounded-2xl border border-line bg-card p-5 shadow-pop"
      >
        <div>
          <h2 className="text-base font-semibold text-ink">{t(step.titleKey)}</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-3">{t(step.descKey)}</p>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-ink-3">
            {t("onboarding.step", { current: index + 1, total: ONBOARDING_STEPS.length })}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={finish}>
              {t("onboarding.skip")}
            </Button>
            {index > 0 && (
              <Button variant="outline" size="sm" onClick={() => setIndex(index - 1)}>
                {t("onboarding.prev")}
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={() => (isLast ? finish() : setIndex(index + 1))}>
              {isLast ? t("onboarding.finish") : t("onboarding.next")}
            </Button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
