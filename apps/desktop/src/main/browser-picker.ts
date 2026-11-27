import type { Rectangle, WebContents } from "electron";

export interface BrowserPickerSelection {
  rect: Rectangle;
  tag?: string;
  label?: string;
  selector?: string;
  html?: string;
  dimensions?: string;
  textPreview?: string;
  styles?: string;
  componentName?: string;
}

const worldId = 1004;

function pick(mode: "element" | "region"): Promise<BrowserPickerSelection | null> {
  type PickerWorld = typeof globalThis & { cancelNautiloPicker?: () => void };
  const world = globalThis as PickerWorld;
  world.cancelNautiloPicker?.();
  return new Promise(resolve => {
    const host = document.createElement("div");
    host.setAttribute("data-nautilo-pointer", "picker");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important";
    const shadow = host.attachShadow({ mode: "closed" });
    const shield = document.createElement("div");
    const dim = document.createElement("div");
    const highlight = document.createElement("div");
    const label = document.createElement("div");
    const style = document.createElement("style");
    style.textContent = `
      :host {
        --br-pick-accent: #3b82f6;
        --br-pick-tint: rgba(59, 130, 246, 0.14);
        --br-pick-surface: rgba(11, 13, 18, 0.96);
        --br-pick-ink: #f1f5f9;
        --br-pick-muted: #94a3b8;
        --br-pick-line: rgba(96, 165, 250, 0.45);
      }
      .shield {
        position: absolute;
        inset: 0;
        pointer-events: auto;
        cursor: crosshair;
        touch-action: none;
      }
      .dim {
        position: absolute;
        inset: 0;
        background: rgba(5, 7, 11, 0.42);
        pointer-events: none;
      }
      .highlight {
        box-sizing: border-box;
        position: absolute;
        left: 0;
        top: 0;
        border: 1.5px solid var(--br-pick-accent);
        border-radius: 4px;
        background: var(--br-pick-tint);
        box-shadow: 0 0 0 1px rgba(11, 13, 18, 0.6), 0 4px 18px rgba(59, 130, 246, 0.2);
      }
      .label {
        position: absolute;
        left: 0;
        top: 0;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 9px;
        border-radius: 7px;
        color: var(--br-pick-ink);
        background: var(--br-pick-surface);
        border: 1px solid var(--br-pick-line);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
        font: 500 11px/1.35 ui-monospace, "Cascadia Code", Consolas, monospace;
        white-space: nowrap;
        max-width: min(92vw, 460px);
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .label .tag { color: #93c5fd; font-weight: 600; }
      .label .dim-txt { color: var(--br-pick-muted); font-variant-numeric: tabular-nums; }
      .label .hint {
        margin-left: 2px;
        padding-left: 6px;
        border-left: 1px solid rgba(255, 255, 255, 0.14);
        color: var(--br-pick-muted);
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        font-size: 10.5px;
        font-weight: 400;
      }
      @media (prefers-reduced-motion: no-preference) {
        .highlight, .label { transition: transform 55ms ease-out, width 55ms ease-out, height 55ms ease-out; }
      }
    `;
    shield.className = "shield";
    dim.className = "dim";
    highlight.className = "highlight";
    label.className = "label";
    highlight.hidden = label.hidden = true;
    dim.hidden = mode !== "region";

    const abort = new AbortController();
    const finish = (selection: BrowserPickerSelection | null) => {
      abort.abort();
      clearTimeout(timeout);
      host.remove();
      delete world.cancelNautiloPicker;
      resolve(selection);
    };
    const timeout = setTimeout(() => finish(null), 120_000);
    world.cancelNautiloPicker = () => finish(null);
    shadow.append(style, dim, shield, highlight, label);
    document.documentElement.append(host);

    const listener = { capture: true, signal: abort.signal };
    let start: { x: number; y: number } | undefined;
    let target: Element | null = null;
    const childTrail: Element[] = [];

    const at = (x: number, y: number): Element | null => {
      shield.style.pointerEvents = "none";
      const element = document.elementsFromPoint(x, y).find(node => !node.closest("[data-nautilo-pointer]"));
      shield.style.pointerEvents = "";
      return element ?? null;
    };

    const rectFor = (rect: DOMRect): Rectangle => {
      const x = Math.max(0, Math.floor(rect.left));
      const y = Math.max(0, Math.floor(rect.top));
      return {
        x,
        y,
        width: Math.max(0, Math.min(innerWidth, Math.ceil(rect.right)) - x),
        height: Math.max(0, Math.min(innerHeight, Math.ceil(rect.bottom)) - y),
      };
    };

    const region = (x: number, y: number) =>
      rectFor(new DOMRect(Math.min(start!.x, x), Math.min(start!.y, y), Math.abs(start!.x - x), Math.abs(start!.y - y)));

    const describe = (element: Element): string => {
      const cls = [...element.classList]
        .filter(name => !name.includes("[") && !name.includes(":") && name.length <= 28)
        .slice(0, 2)
        .map(name => "." + name)
        .join("");
      return element.localName + (element.id ? "#" + element.id : "") + cls;
    };

    const draw = (rect: Rectangle, title: string, hintText?: string) => {
      highlight.hidden = label.hidden = false;
      highlight.style.transform = `translate(${rect.x}px,${rect.y}px)`;
      highlight.style.width = rect.width + "px";
      highlight.style.height = rect.height + "px";
      if (mode === "region") {
        dim.style.clipPath = `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${rect.x}px ${rect.y}px, ${rect.x}px ${rect.y + rect.height}px, ${rect.x + rect.width}px ${rect.y + rect.height}px, ${rect.x + rect.width}px ${rect.y}px, ${rect.x}px ${rect.y}px)`;
      }
      label.textContent = "";
      const tagSpan = document.createElement("span");
      tagSpan.className = "tag";
      tagSpan.textContent = title;
      const dimSpan = document.createElement("span");
      dimSpan.className = "dim-txt";
      dimSpan.textContent = `${rect.width}×${rect.height}`;
      label.append(tagSpan, dimSpan);
      if (hintText) {
        const hintSpan = document.createElement("span");
        hintSpan.className = "hint";
        hintSpan.textContent = hintText;
        label.append(hintSpan);
      }
      const left = Math.max(6, Math.min(rect.x, innerWidth - label.offsetWidth - 6));
      const top = rect.y > 34 ? rect.y - 30 : Math.min(innerHeight - 30, rect.y + rect.height + 6);
      label.style.transform = `translate(${left}px,${top}px)`;
    };

    const selectorFor = (element: Element): string => {
      const parts: string[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const tag = CSS.escape(node.localName);
        if (node.id) {
          const path = ["#" + CSS.escape(node.id), ...parts].join(" > ");
          if (document.querySelectorAll(path).length === 1) return path;
        }
        const siblings = [...(node.parentElement?.children ?? [])].filter(sibling => sibling.localName === node!.localName);
        parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
        const path = parts.join(" > ");
        if (document.querySelectorAll(path).length === 1) return path;
      }
      return parts.join(" > ");
    };

    const extractStyles = (element: Element): string => {
      const cs = getComputedStyle(element);
      const entries: string[] = [];
      if (cs.display) entries.push(`display:${cs.display}`);
      if (cs.fontSize) entries.push(`font:${cs.fontSize}/${cs.lineHeight} ${cs.fontWeight}`);
      if (cs.color) entries.push(`color:${cs.color}`);
      if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") {
        entries.push(`bg:${cs.backgroundColor}`);
      }
      if (cs.padding && cs.padding !== "0px") entries.push(`padding:${cs.padding}`);
      if (cs.borderRadius && cs.borderRadius !== "0px") entries.push(`radius:${cs.borderRadius}`);
      return entries.join("; ");
    };

    const finalizeElement = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      const clone = element.cloneNode(true) as Element;
      const inputs = [...clone.querySelectorAll("input,textarea")];
      if (clone.matches("input,textarea")) inputs.push(clone);
      for (const input of inputs) {
        input.removeAttribute("value");
        if (input.localName === "textarea") input.textContent = "";
      }
      const rawText = ((element as HTMLElement).innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
      const textPreview = rawText ? rawText.slice(0, 120) : undefined;
      finish({
        rect: rectFor(bounds),
        tag: element.localName,
        label: describe(element),
        selector: selectorFor(element),
        html: clone.outerHTML.slice(0, 2400),
        dimensions: `${Math.round(bounds.width)} × ${Math.round(bounds.height)}`,
        textPreview,
        styles: extractStyles(element),
      });
    };

    shield.addEventListener("pointermove", event => {
      if (!event.isTrusted) return;
      if (mode === "region") {
        if (start) draw(region(event.clientX, event.clientY), "选区", "松开截屏 · Esc 取消");
      } else {
        const hit = at(event.clientX, event.clientY);
        if (hit && hit !== target) {
          target = hit;
          childTrail.length = 0;
          draw(rectFor(target.getBoundingClientRect()), describe(target), "↑/↓ 层级 · 点击选中");
        }
      }
    }, listener);

    shield.addEventListener("pointerdown", event => {
      if (!event.isTrusted || event.button !== 0) return;
      event.preventDefault();
      if (mode === "region") {
        start = { x: event.clientX, y: event.clientY };
        shield.setPointerCapture(event.pointerId);
      }
    }, listener);

    shield.addEventListener("pointerup", event => {
      if (!event.isTrusted || event.button !== 0) return;
      event.preventDefault();
      if (mode === "region") {
        if (!start) return;
        const rect = region(event.clientX, event.clientY);
        start = undefined;
        if (rect.width > 2 && rect.height > 2) finish({ rect });
        return;
      }
      const chosen = target ?? at(event.clientX, event.clientY);
      if (!chosen) return;
      finalizeElement(chosen);
    }, listener);

    window.addEventListener("keydown", event => {
      if (!event.isTrusted) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(null);
        return;
      }
      if (mode === "element" && target) {
        if (event.key === "ArrowUp" || event.key === "w" || event.key === "W") {
          const parent = target.parentElement;
          if (parent && parent !== document.documentElement) {
            event.preventDefault();
            event.stopImmediatePropagation();
            childTrail.push(target);
            target = parent;
            draw(rectFor(target.getBoundingClientRect()), describe(target), "↑/↓ 层级 · Enter/点击选中");
          }
        } else if (event.key === "ArrowDown" || event.key === "s" || event.key === "S") {
          const child = childTrail.pop() ?? target.firstElementChild;
          if (child) {
            event.preventDefault();
            event.stopImmediatePropagation();
            target = child;
            draw(rectFor(target.getBoundingClientRect()), describe(target), "↑/↓ 层级 · Enter/点击选中");
          }
        } else if (event.key === "Enter") {
          event.preventDefault();
          event.stopImmediatePropagation();
          finalizeElement(target);
        }
      }
    }, listener);
  });
}

export function pickBrowserRegion(page: WebContents, mode: "element" | "region"): Promise<BrowserPickerSelection | null> {
  return page.executeJavaScriptInIsolatedWorld(worldId, [{ code: `(${pick.toString()})(${JSON.stringify(mode)})` }]);
}

export async function cancelBrowserPicker(page: WebContents) {
  if (!page.isDestroyed()) await page.executeJavaScriptInIsolatedWorld(worldId, [{ code: "globalThis.cancelNautiloPicker?.()" }]);
}
