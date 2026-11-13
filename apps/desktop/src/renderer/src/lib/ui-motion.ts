import { useLayoutEffect, useRef } from "react";
import { animate, useReducedMotion } from "framer-motion";
import { useSettingsStore } from "../stores/settings";

export const UI_EASE_OUT = [0.23, 1, 0.32, 1] as const;
const easing = "cubic-bezier(0.23, 1, 0.32, 1)";
export const UI_SPRING = { type:"spring" as const, duration:0.5, bounce:0.2 };

export function useUiReducedMotion(): boolean {
  const systemReduced = useReducedMotion();
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

export function useMessageEntrance(sessionId: string, messageId?: string) {
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
    const animation = element.animate([
      { opacity: 0.45, transform: "translateY(8px) scale(0.985)" },
      { opacity: 1, transform: "translateY(0px) scale(1)" }
    ], { duration: 200, easing });
    return () => animation.cancel();
  }, [key, reduced]);
  return ref;
}
