import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { Button } from "../../components/ui/Button";
import { ONBOARDING_STEPS } from "./steps";

const PADDING = 8;
const CARD_WIDTH = 352;
const TARGET_POLL_TIMEOUT = 2000;

function resolveTargetRect(selector: string): DOMRect | null {
  // Hidden keep-alive panes can contain an earlier matching selector.
  for (const element of document.querySelectorAll(selector)) {
    if (!element.getClientRects().length) continue;
    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") continue;
    const rect = element.getBoundingClientRect();
    if (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    )
      return rect;
  }
  return null;
}

export function OnboardingTour(): JSX.Element | null {
  const { t, locale } = useI18n();
  const completed = useSettingsStore((state) => state.onboardingCompleted);
  const setOnboardingCompleted = useSettingsStore((state) => state.setOnboardingCompleted);
  const reduceMotion = useSettingsStore((state) => state.reduceMotion);
  const navigate = useNavigate();
  const location = useLocation();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [cardHeight, setCardHeight] = useState(200);
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  });
  const card = useRef<HTMLDivElement>(null);
  const step = ONBOARDING_STEPS[index]!;
  const lang = locale === "zh-CN" ? "zh" : "en";
  const isLast = index === ONBOARDING_STEPS.length - 1;

  useEffect(() => {
    if (!completed) setIndex(0);
  }, [completed]);
  useEffect(() => {
    if (!completed && location.pathname !== step.path) navigate(step.path);
  }, [completed, step.path, location.pathname, navigate]);
  useEffect(() => {
    if (completed) return;
    let cancelled = false;
    let timer: number | undefined;
    let frame: number | undefined;
    const startedAt = Date.now();
    setRect(null);
    const measure = (): void => {
      if (cancelled) return;
      if (timer) window.clearTimeout(timer);
      const found = resolveTargetRect(step.target);
      setRect(found);
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      if (card.current) setCardHeight(card.current.getBoundingClientRect().height);
      if (!found && Date.now() - startedAt < TARGET_POLL_TIMEOUT)
        timer = window.setTimeout(measure, 100);
    };
    const remeasure = (): void => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(remeasure);
    if (card.current) observer.observe(card.current);
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
    };
  }, [completed, step]);

  if (completed) return null;
  const finish = (): void => setOnboardingCompleted(true);
  const width = Math.min(CARD_WIDTH, viewport.width - 32);
  const desiredTop = rect
    ? rect.top - PADDING - cardHeight - 14 >= 16
      ? rect.top - PADDING - cardHeight - 14
      : rect.bottom + PADDING + 14
    : (viewport.height - cardHeight) / 2;
  const top = Math.max(16, Math.min(desiredTop, viewport.height - cardHeight - 16));
  const left = Math.max(
    16,
    Math.min(rect ? rect.left : (viewport.width - width) / 2, viewport.width - width - 16)
  );
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) finish();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[80]">
          {rect ? (
            <motion.div
              initial={false}
              animate={{
                top: rect.top - PADDING,
                left: rect.left - PADDING,
                width: rect.width + PADDING * 2,
                height: rect.height + PADDING * 2
              }}
              transition={{ duration: reduceMotion ? 0 : 0.16 }}
              className="pointer-events-none fixed rounded-xl border border-line-strong shadow-[0_0_0_9999px_rgba(0,0,0,0.28)]"
            />
          ) : (
            <div className="absolute inset-0 bg-black/30" />
          )}
        </DialogPrimitive.Overlay>
        <DialogPrimitive.Content
          ref={card}
          onPointerDownOutside={(event) => event.preventDefault()}
          className="fixed z-[81] max-h-[calc(100vh-32px)] overflow-y-auto rounded-xl border border-line bg-card p-5 shadow-pop outline-none"
          style={{ top, left, width }}
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <DialogPrimitive.Title className="text-lg font-semibold text-ink">
              {step.title[lang]}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label={t("common.close")}
              className="rounded p-1 text-ink-3 hover:bg-panel focus-visible:ring-2 focus-visible:ring-accent"
            >
              <X className="h-4 w-4" aria-hidden />
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="text-sm leading-relaxed text-ink-3">
            {step.description[lang]}
          </DialogPrimitive.Description>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <span className="text-sm text-ink-3" aria-live="polite">
              {index + 1} / {ONBOARDING_STEPS.length}
            </span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={finish}>
                {t("onboarding.skip")}
              </Button>
              {index > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIndex((current) => Math.max(0, current - 1))}
                >
                  {t("onboarding.prev")}
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={() =>
                  isLast
                    ? finish()
                    : setIndex((current) => Math.min(ONBOARDING_STEPS.length - 1, current + 1))
                }
              >
                {isLast ? t("onboarding.finish") : t("onboarding.next")}
              </Button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
