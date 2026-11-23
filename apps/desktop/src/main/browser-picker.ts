import type { Rectangle, WebContents } from "electron";

type Selection = {rect:Rectangle; selector?:string; html?:string; dimensions?:string};
const worldId = 1004;

function pick(mode: "element" | "region"): Promise<Selection | null> {
  type PickerWorld = typeof globalThis & { cancelNautiloPicker?: () => void };
  const world = globalThis as PickerWorld;
  world.cancelNautiloPicker?.();
  return new Promise(resolve => {
    const host = document.createElement("div");
    host.setAttribute("data-nautilo-pointer", "picker");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important";
    const shadow = host.attachShadow({mode:"closed"});
    const highlight = document.createElement("div");
    const label = document.createElement("div");
    const shield = document.createElement("div");
    const style = document.createElement("style");
    style.textContent = `
      :host{--br-pick-accent:#3b82f6;--br-pick-tint:rgba(59,130,246,.12);--br-pick-surface:#0d0f14;--br-pick-ink:#f8fafc;--br-pick-line:rgba(59,130,246,.45)}
      .shield{position:absolute;inset:0;pointer-events:auto;cursor:crosshair;touch-action:none}
      .highlight{box-sizing:border-box;position:absolute;left:0;top:0;border:1.5px solid var(--br-pick-accent);border-radius:3px;background:var(--br-pick-tint)}
      .label{position:absolute;left:0;top:0;padding:3px 8px;border-radius:6px;color:var(--br-pick-ink);background:var(--br-pick-surface);border:1px solid var(--br-pick-line);font:400 11px/1.4 "Noto Sans SC",sans-serif;white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis}
      @media(prefers-reduced-motion:no-preference){.highlight,.label{transition:transform 60ms linear}}
    `;
    shield.className = "shield";
    highlight.className = "highlight";
    label.className = "label";
    highlight.hidden = label.hidden = true;
    const abort = new AbortController();
    const finish = (selection: Selection | null) => {
      abort.abort();
      clearTimeout(timeout);
      host.remove();
      delete world.cancelNautiloPicker;
      resolve(selection);
    };
    const timeout = setTimeout(() => finish(null), 120_000);
    world.cancelNautiloPicker = () => finish(null);
    shadow.append(style,shield,highlight,label);
    document.documentElement.append(host);
    const listener = {capture:true,signal:abort.signal};
    let start: {x:number;y:number} | undefined;
    let target: Element | null = null;
    const at = (x:number,y:number) => {
      shield.style.pointerEvents = "none";
      const element = document.elementsFromPoint(x,y).find(node=>!node.closest("[data-nautilo-pointer]"));
      shield.style.pointerEvents = "";
      return element ?? null;
    };
    const rectFor = (rect: DOMRect): Rectangle => {
      const x = Math.max(0, Math.floor(rect.left)), y = Math.max(0, Math.floor(rect.top));
      return {x, y, width:Math.max(0,Math.min(innerWidth,Math.ceil(rect.right))-x), height:Math.max(0,Math.min(innerHeight,Math.ceil(rect.bottom))-y)};
    };
    const region = (x:number,y:number) => rectFor(new DOMRect(Math.min(start!.x,x),Math.min(start!.y,y),Math.abs(start!.x-x),Math.abs(start!.y-y)));
    const describe = (element:Element) => element.localName
      + (element.id ? "#" + element.id : "")
      + [...element.classList].slice(0,2).map(name => "." + name).join("");
    const draw = (rect:Rectangle, title:string) => {
      highlight.hidden = label.hidden = false;
      highlight.style.transform = `translate(${rect.x}px,${rect.y}px)`;
      highlight.style.width = rect.width + "px";
      highlight.style.height = rect.height + "px";
      label.textContent = `${title} · ${rect.width}×${rect.height}`;
      label.style.transform = `translate(${Math.min(rect.x,innerWidth-label.offsetWidth)}px,${rect.y > 28 ? rect.y - 25 : rect.y + 4}px)`;
    };
    const selectorFor = (element: Element) => {
      const parts: string[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const tag = CSS.escape(node.localName);
        if (node.id) {
          const path = ["#" + CSS.escape(node.id), ...parts].join(" > ");
          if (document.querySelectorAll(path).length === 1) return path;
        }
        const siblings = [...(node.parentElement?.children ?? [])].filter(sibling => sibling.localName === node!.localName);
        parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + (siblings.indexOf(node)+1) + ")" : tag);
        const path = parts.join(" > ");
        if (document.querySelectorAll(path).length === 1) return path;
      }
      return parts.join(" > ");
    };
    shield.addEventListener("pointermove", event => {
      if (!event.isTrusted) return;
      if (mode === "region") {
        if (start) draw(region(event.clientX,event.clientY),"选区");
      } else {
        target = at(event.clientX,event.clientY);
        if (target) draw(rectFor(target.getBoundingClientRect()),describe(target));
      }
    }, listener);
    shield.addEventListener("pointerdown", event => {
      if (!event.isTrusted || event.button !== 0) return;
      event.preventDefault();
      if (mode === "region") {
        start = {x:event.clientX,y:event.clientY};
        shield.setPointerCapture(event.pointerId);
      }
    }, listener);
    shield.addEventListener("pointerup", event => {
      if (!event.isTrusted || event.button !== 0) return;
      event.preventDefault();
      if (mode === "region") {
        if (!start) return;
        const rect = region(event.clientX,event.clientY);
        start = undefined;
        if (rect.width > 2 && rect.height > 2) finish({rect});
        return;
      }
      const element = at(event.clientX,event.clientY);
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      const clone = element.cloneNode(true) as Element;
      const inputs = [...clone.querySelectorAll("input,textarea")];
      if (clone.matches("input,textarea")) inputs.push(clone);
      for (const input of inputs) {
        input.removeAttribute("value");
        if (input.localName === "textarea") input.textContent = "";
      }
      finish({rect:rectFor(bounds),selector:selectorFor(element),html:clone.outerHTML.slice(0,2400),
        dimensions:`${Math.round(bounds.width)} × ${Math.round(bounds.height)} CSS px`});
    }, listener);
    window.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !event.isTrusted) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(null);
    }, listener);
  });
}

export function pickBrowserRegion(page: WebContents, mode: "element" | "region"): Promise<Selection | null> {
  return page.executeJavaScriptInIsolatedWorld(worldId,[{code:`(${pick.toString()})(${JSON.stringify(mode)})`}]);
}

export async function cancelBrowserPicker(page: WebContents) {
  if (!page.isDestroyed()) await page.executeJavaScriptInIsolatedWorld(worldId,[{code:"globalThis.cancelNautiloPicker?.()"}]);
}
