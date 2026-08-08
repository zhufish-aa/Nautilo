// The Tauri bridge must install window.agenthub before any module that reads
// it at evaluation time (e.g. lib/bridge.ts's isElectron) — keep this first.
import "./lib/tauri-bridge";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { I18nProvider } from "./lib/i18n";
import "./styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <I18nProvider>
        <App />
      </I18nProvider>
    </HashRouter>
  </StrictMode>
);
