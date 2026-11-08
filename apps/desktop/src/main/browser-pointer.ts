import type { WebContents } from "electron";
import { browserDeadline } from "./browser-errors";

type PointerMark = "move" | "click" | "drag" | "scroll" | "type";

function paint(x: number, y: number, mark: PointerMark) {
  const world = globalThis as typeof globalThis & {
    __nautiloPointer?: { host: HTMLElement; ring: HTMLElement; timer?: number };
  };
  let pointer = world.__nautiloPointer;
  if (!pointer?.host.isConnected) {
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("data-nautilo-pointer", "");
    host.inert = true;
    host.style.cssText =
      "all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important";
    const shadow = host.attachShadow({ mode: "closed" });
    const arrow = document.createElement("span"),
      ring = document.createElement("span");
    arrow.style.cssText =
      "position:absolute;width:16px;height:22px;background:#8155df;clip-path:polygon(0 0,100% 65%,56% 69%,36% 100%);filter:drop-shadow(0 1px 1px #150b2f);pointer-events:none";
    ring.style.cssText =
      "position:absolute;left:-9px;top:-9px;width:18px;height:18px;border:2px solid #ac89ff;border-radius:50%;box-sizing:border-box;pointer-events:none";
    shadow.append(ring, arrow);
    document.documentElement.append(host);
    pointer = world.__nautiloPointer = { host, ring };
  }
  const { host, ring } = pointer;
  for (const animation of ring.getAnimations()) animation.cancel();
  clearTimeout(pointer.timer);
  host.style.setProperty("opacity", "1", "important");
  host.style.setProperty(
    "transform",
    "translate(" + x + "px," + y + "px)",
    "important",
  );
  const reduced = matchMedia("(prefers-reduced-motion:reduce)").matches;
  if (!reduced)
    host.style.setProperty(
      "transition",
      "transform 85ms ease-out,opacity 180ms ease",
      "important",
    );
  ring.style.opacity = mark === "move" ? "0" : "1";
  if (!reduced && mark !== "move")
    ring.animate(
      [
        { transform: "scale(.65)", opacity: 1 },
        { transform: "scale(2.1)", opacity: 0 },
      ],
      { duration: 420, fill: "forwards" },
    );
  pointer.timer = window.setTimeout(
    () => host.style.setProperty("opacity", "0", "important"),
    950,
  );
}

export function showBrowserPointer(
  wc: WebContents,
  x: number,
  y: number,
  mark: PointerMark,
) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const code =
    "(" +
    paint.toString() +
    ")(" +
    [x, y, JSON.stringify(mark)].join(",") +
    ")";
  return browserDeadline(
    wc.executeJavaScriptInIsolatedWorld(1001, [{ code }]),
    1000,
    "pointer overlay",
  ).catch(() => {});
}
