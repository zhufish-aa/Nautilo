import type { WebContents } from "electron";
import { browserDeadline } from "./browser-errors";

type PointerMark = "move" | "click" | "drag" | "scroll" | "type";

function paint(x: number, y: number, mark: PointerMark) {
  const world = globalThis as typeof globalThis & {
    __nautiloPointer?: { host: HTMLElement; ring: HTMLElement; label: HTMLElement };
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
      ring = document.createElement("span"), label = document.createElement("span");
    arrow.style.cssText =
      "position:absolute;width:15px;height:21px;background:#263b4d;clip-path:polygon(0 0,100% 65%,56% 69%,36% 100%);filter:drop-shadow(0 1px 1px #fff);pointer-events:none";
    ring.style.cssText =
      "position:absolute;left:-9px;top:-9px;width:18px;height:18px;border:2px solid #67b0f5;border-radius:50%;box-sizing:border-box;pointer-events:none";
    label.style.cssText = 'position:absolute;left:14px;top:17px;padding:4px 9px;border-radius:10px;background:#fff;color:#263641;box-shadow:0 2px 10px #17344c20;white-space:nowrap;font:11px/1.4 "Noto Sans SC","Microsoft YaHei UI",system-ui,sans-serif';
    shadow.append(ring, arrow, label);
    document.documentElement.append(host);
    pointer = world.__nautiloPointer = { host, ring, label };
  }
  const { host, ring } = pointer;
  pointer.label.textContent = ({move:'浏览网页',click:'点击',drag:'拖动',scroll:'浏览网页',type:'输入'} as const)[mark];
  for (const animation of ring.getAnimations()) animation.cancel();
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
}

const positions=new WeakMap<WebContents,{x:number;y:number}>();
const activity=new WeakMap<WebContents,boolean>();
export function forgetBrowserPointer(page:WebContents){activity.delete(page);}
export function setBrowserPointerActive(page:WebContents,active:boolean) {
  if(page.isDestroyed() || activity.get(page) === active)return;
  activity.set(page,active);
  const point=positions.get(page);
  const restore=active && point ? `(${paint.toString()})(${point.x},${point.y},"move");` : "";
  const code=restore+`globalThis.__nautiloPointer?.host.style.setProperty("opacity",${JSON.stringify(active?"1":"0")},"important");`;
  void browserDeadline(page.executeJavaScriptInIsolatedWorld(1001,[{code}]),1000,"pointer control state").catch(()=>{if(activity.get(page)===active)activity.delete(page);});
}

export function showBrowserPointer(
  wc: WebContents,
  x: number,
  y: number,
  mark: PointerMark,
) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  positions.set(wc,{x,y});
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
