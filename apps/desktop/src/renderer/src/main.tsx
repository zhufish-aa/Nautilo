// The Tauri bridge must install window.agenthub before any module that reads
// it at evaluation time (e.g. lib/bridge.ts's isElectron) — keep this first.
import "./lib/tauri-bridge";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { I18nProvider } from "./lib/i18n";
import "./styles/global.css";

// A renderer crash must never leave a silent white window: surface the error
// as plain DOM so it can be reported (and so the pattern background is not
// mistaken for a loading state).
function showFatalOverlay(text: string): void {
  const existing = document.getElementById("fatal-overlay");
  if (existing) {
    existing.textContent += `\n${text}`;
    return;
  }
  const overlay = document.createElement("pre");
  overlay.id = "fatal-overlay";
  overlay.style.cssText =
    "position:fixed;inset:16px;z-index:99999;overflow:auto;padding:16px;" +
    "background:#fff2f0;color:#a8071a;border:2px solid #ffa39e;border-radius:8px;" +
    "font:12px/1.5 monospace;white-space:pre-wrap;";
  overlay.textContent = `界面渲染出错，请把这段发给开发者:\n\n${text}`;
  document.body.appendChild(overlay);
}
window.addEventListener("error", (event) => {
  showFatalOverlay(`${event.message}\n${event.error?.stack ?? ""}`.trim());
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  showFatalOverlay(reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason));
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <I18nProvider>
        <App />
      </I18nProvider>
    </HashRouter>
  </StrictMode>
);
