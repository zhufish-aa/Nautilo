export const composerEase = "cubic-bezier(.22, 1, .36, 1)";

export function flashComposer(box: HTMLElement | null, launch = false): void {
  const edge = box?.querySelector<HTMLElement>(".composer-pulse");
  if (!edge?.animate) return;
  edge.getAnimations().forEach(animation => animation.cancel());
  edge.animate([
    { opacity: 0, transform: "scaleX(.08)" },
    { opacity: 1, offset: .25 },
    { opacity: 0, transform: "scaleX(1)" }
  ], { duration: launch ? 320 : 280, easing: composerEase });
  if (!launch) return;
  const arrow = box?.querySelector<HTMLElement>(".composer-launch-arrow");
  arrow?.getAnimations().forEach(animation => animation.cancel());
  arrow?.animate([
    { opacity: 1, transform: "translateY(0)" },
    { opacity: 0, transform: "translateY(-12px)" }
  ], { duration: 150, easing: "ease-in" });
}
