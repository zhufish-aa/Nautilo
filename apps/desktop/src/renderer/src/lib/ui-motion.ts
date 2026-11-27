import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { animate } from "framer-motion";
import { useSettingsStore } from "../stores/settings";

export const UI_EASE_OUT = [0.23, 1, 0.32, 1] as const;
export const UI_SPRING = { type:"spring" as const, duration:0.5, bounce:0.2 };

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
const readSystemReducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.(reducedMotionQuery).matches;
function subscribeSystemReducedMotion(update: () => void) {
  const media = window.matchMedia?.(reducedMotionQuery);
  media?.addEventListener?.("change", update);
  return () => media?.removeEventListener?.("change", update);
}

export function useUiReducedMotion(): boolean {
  const systemReduced = useSyncExternalStore(subscribeSystemReducedMotion, readSystemReducedMotion, () => false);
  const appReduced = useSettingsStore(state => state.reduceMotion);
  return Boolean(systemReduced || appReduced);
}

/** Animate the existing surface, without remounting its state or delaying navigation. */
export function useSurfaceEntrance<T extends HTMLElement>(key: unknown, active = true) {
  const ref = useRef<T>(null);
  const reduced = useUiReducedMotion();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || reduced || !element?.animate) return;
    const initialOpacity = element.style.opacity;
    const initialTransform = element.style.transform;
    const animation = animate(element, {
      opacity:[0.6,1],
      transform:["translateY(10px) scale(0.995)","translateY(0px) scale(1)"]
    }, UI_SPRING);
    return () => {
      animation.stop();
      element.style.opacity = initialOpacity;
      element.style.transform = initialTransform;
    };
  }, [key, active, reduced]);
  return ref;
}

const outgoing = new Map<string, number>();
const messageKey = (sessionId: string, messageId: string) => `${sessionId}:${messageId}`;

/** Only local submissions get an entrance; history, replay and stream patches never do. */
export function markOutgoingMessage(sessionId: string, messageId: string): void {
  const now = performance.now();
  for (const [key, at] of outgoing) if (now - at > 5000) outgoing.delete(key);
  outgoing.set(messageKey(sessionId, messageId), now);
}

export function useMessageEntrance(sessionId: string, messageId?: string, motion?: {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const entrance = useRef<{ key: string; play: boolean }>();
  const reduced = useUiReducedMotion();
  const key = messageKey(sessionId, messageId ?? "");
  useLayoutEffect(() => {
    if (entrance.current?.key !== key) {
      const at = outgoing.get(key);
      entrance.current = { key, play: at !== undefined && performance.now() - at < 5000 };
      outgoing.delete(key);
    }
    const element = ref.current;
    if (!entrance.current.play || reduced || !element?.animate) return;
    const prevOrigin = element.style.transformOrigin;
    element.style.transformOrigin = "bottom right";
    element.setAttribute("data-just-sent", "true");
    const animation = element.animate(motion?.keyframes ?? [
      { opacity: 0, transform: "translate3d(0, 22px, 0) scale(0.955)" },
      { opacity: 1, transform: "translate3d(0, -1px, 0) scale(1.003)", offset: 0.72 },
      { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" }
    ], motion?.options ?? { duration: 360, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    const glintTimer = window.setTimeout(() => {
      element.removeAttribute("data-just-sent");
    }, 620);
    return () => {
      window.clearTimeout(glintTimer);
      element.removeAttribute("data-just-sent");
      element.style.transformOrigin = prevOrigin;
      animation.cancel();
    };
  }, [key, reduced, motion]);
  return ref;
}
