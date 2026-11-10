import type { WebContents } from "electron";
import { browserDeadline } from "./browser-errors";

export type BrowserPresence = {
  mode: "agent" | "user" | "ready" | "stopped";
  title: string;
  action?: string;
  controlKey: string;
};

// Isolated-world UI: no preload, Node API or page-accessible IPC bridge.
// The closed shadow root keeps controls out of page locators and snapshots.
function paintPresence(state: BrowserPresence) {
  const world = globalThis as typeof globalThis & {
    __nautiloPresence?: { host: HTMLElement; root: ShadowRoot; key: string };
  };
  let overlay = world.__nautiloPresence;
  if (!overlay?.host.isConnected) {
    const host = document.createElement("div");
    host.setAttribute("data-nautilo-pointer", "presence");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      *{box-sizing:border-box}button{font:inherit;cursor:pointer} .edge{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity 180ms ease;border-radius:6px}
      :host([data-mode=agent]) .edge{opacity:1;box-shadow:inset 0 0 2px 1px #399cff,inset 0 0 23px 7px #319dff85,inset 0 0 64px 8px #49b4ff30}
      .edge:after{content:"";position:absolute;inset:0;background:radial-gradient(circle,#effaffbd .7px,transparent .9px) 0 0/7px 7px;mask-image:linear-gradient(to right,#000,transparent 38px,transparent calc(100% - 38px),#000),linear-gradient(to bottom,#000,transparent 38px,transparent calc(100% - 38px),#000);border-radius:inherit}
      .bar{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;max-width:calc(100vw - 28px);padding:9px 10px 9px 14px;background:#273642ed;color:#f5f9ff;border:1px solid #ffffff24;border-radius:15px;box-shadow:0 8px 32px #14202b38;backdrop-filter:blur(18px);font:12px/1.45 "Noto Sans SC","Microsoft YaHei UI",system-ui,sans-serif;pointer-events:auto}
      .identity{display:grid;gap:2px;min-width:90px;max-width:250px}.title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.status{font-size:11px;color:#a8c9e9}.orb{width:18px;height:18px;flex:none;color:#b6d9ff}.orb svg{display:block;width:18px;height:18px}.bar button{flex:none;min-height:30px;padding:6px 10px;border:0;border-radius:8px;color:#f3f6fb;background:#ffffff15;white-space:nowrap}.bar button:hover{background:#ffffff29}.bar button:focus-visible{outline:2px solid #a5d5ff;outline-offset:2px}.bar .stop{background:transparent;color:#f5a79e}.bar .stop:hover{background:#ff978314}.bar[hidden],button[hidden]{display:none!important}
      :host([data-mode=agent]) .orb svg{animation:spin 3s linear infinite}:host([data-mode=user]) .status{color:#d2d7df}:host([data-mode=stopped]) .status{color:#f5b6ad}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.edge{transition:none}:host([data-mode=agent]) .orb svg{animation:none}}
    </style><div class="edge"></div><div class="bar"><span class="orb"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1"/></svg></span><span class="identity"><span class="title"></span><span class="status"></span></span><button data-action="takeover">接管</button><button data-action="resume">交还 AI</button><button class="stop" data-action="stop">停止</button></div>`;
    root.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      location.href = "nautilo-control://" + world.__nautiloPresence!.key + "/" + button.dataset.action;
    });
    document.documentElement.append(host);
    overlay = world.__nautiloPresence = { host, root, key: state.controlKey };
  }
  overlay.host.dataset.mode = state.mode;
  overlay.key = state.controlKey;
  overlay.root.querySelector(".title")!.textContent = state.title;
  (overlay.root.querySelector(".bar") as HTMLElement).hidden=state.mode === "ready";
  overlay.root.querySelector(".status")!.textContent = state.mode === "agent"
    ? state.action || "AI 控制中"
    : state.mode === "stopped" ? "浏览操作已停止" : state.mode === "user" ? "你正在控制" : "网页就绪";
  for (const button of overlay.root.querySelectorAll<HTMLButtonElement>("[data-action]")) {
    const action = button.dataset.action;
    button.hidden = action === "resume" ? !["user", "stopped"].includes(state.mode)
      : action === "takeover" ? ["user", "stopped"].includes(state.mode) : state.mode !== "agent";
  }
}

const previous = new WeakMap<WebContents, string>();
export function forgetBrowserPresence(page: WebContents) { previous.delete(page); }
export function showBrowserPresence(page: WebContents, state: BrowserPresence) {
  if (page.isDestroyed()) return;
  const value = JSON.stringify(state);
  if (previous.get(page) === value) return;
  previous.set(page, value);
  void browserDeadline(page.executeJavaScriptInIsolatedWorld(1002, [{
    code: "(" + paintPresence.toString() + ")(" + value + ")",
  }]), 1000, "browser control overlay").catch(() => previous.delete(page));
}
