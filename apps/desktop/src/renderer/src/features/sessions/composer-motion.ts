export const composerEase = "cubic-bezier(.19, 1, .22, 1)";
export const composerSpring = "cubic-bezier(.34, 1.56, .64, 1)";

/**
 * Pure GPU-composited (transform + opacity only) tactile launch choreography:
 * 1. Top-edge Nacre beam sweep across the composer rim.
 * 2. On full send (`launch = true`):
 *    - Expanding shockwave ring from the Send button.
 *    - Crisp spring recoil on the Send button itself.
 *    - Launch arrow projectile shooting smoothly upward.
 *    - Soft upward energy streak lifting off the composer toward the timeline.
 *    - Subtle recoil impulse on the composer card (when not FLIP-morphing).
 */
export function flashComposer(box: HTMLElement | null, launch = false, morphing = false): void {
  if (!box) return;

  const edge = box.querySelector<HTMLElement>(".composer-pulse");
  if (edge?.animate) {
    edge.getAnimations().forEach(animation => animation.cancel());
    edge.animate([
      { opacity: 0, transform: "translate3d(0, 0, 0) scaleX(.08)" },
      { opacity: 1, transform: "translate3d(0, 0, 0) scaleX(.62)", offset: 0.24 },
      { opacity: 0.85, transform: "translate3d(0, 0, 0) scaleX(.94)", offset: 0.62 },
      { opacity: 0, transform: "translate3d(0, 0, 0) scaleX(1)" }
    ], { duration: launch ? 460 : 300, easing: composerEase });
  }

  if (!launch) return;

  const ripple = box.querySelector<HTMLElement>(".composer-send-ripple");
  if (ripple?.animate) {
    ripple.getAnimations().forEach(animation => animation.cancel());
    ripple.animate([
      { opacity: 0.65, transform: "translate3d(0, 0, 0) scale(.86)" },
      { opacity: 0.28, transform: "translate3d(0, 0, 0) scale(1.45)", offset: 0.48 },
      { opacity: 0, transform: "translate3d(0, 0, 0) scale(1.95)" }
    ], { duration: 380, easing: composerEase });
  }

  const sendBtn = box.querySelector<HTMLElement>(".composer-send");
  if (sendBtn?.animate) {
    sendBtn.getAnimations().forEach(animation => animation.cancel());
    sendBtn.animate([
      { transform: "scale(1)" },
      { transform: "scale(.88)", offset: 0.22 },
      { transform: "scale(1.04)", offset: 0.62 },
      { transform: "scale(1)" }
    ], { duration: 300, easing: composerSpring });
  }

  const arrow = box.querySelector<HTMLElement>(".composer-launch-arrow");
  if (arrow?.animate) {
    arrow.getAnimations().forEach(animation => animation.cancel());
    arrow.animate([
      { opacity: 0.95, transform: "translate3d(0, 0, 0) scale(1)" },
      { opacity: 0.8, transform: "translate3d(0, -11px, 0) scale(1.02)", offset: 0.45 },
      { opacity: 0, transform: "translate3d(0, -24px, 0) scale(.82)" }
    ], { duration: 320, easing: composerEase });
  }

  const streak = box.querySelector<HTMLElement>(".composer-send-streak");
  if (streak?.animate) {
    streak.getAnimations().forEach(animation => animation.cancel());
    streak.animate([
      { opacity: 0, transform: "translate3d(0, 2px, 0) scaleX(.8) scaleY(.75)" },
      { opacity: 0.48, transform: "translate3d(0, -8px, 0) scaleX(.94) scaleY(1)", offset: 0.3 },
      { opacity: 0, transform: "translate3d(0, -28px, 0) scaleX(1) scaleY(.55)" }
    ], { duration: 380, easing: composerEase });
  }

  if (!morphing && box.animate) {
    box.animate([
      { transform: "translate3d(0, 0, 0)" },
      { transform: "translate3d(0, -2px, 0)", offset: 0.28 },
      { transform: "translate3d(0, 0, 0)" }
    ], { duration: 280, easing: composerSpring });
  }
}
