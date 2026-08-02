import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { Workflow } from "lucide-react";
import { AppShell } from "./components/layout/AppShell";
import { Toaster } from "./components/ui/Toaster";
import { TooltipProvider } from "./components/ui/Tooltip";
import { ImageLightbox } from "./features/timeline/ImageLightbox";
import { FilePreviewDrawer } from "./features/timeline/FilePreviewDrawer";
import { AgentsPage } from "./features/agents/AgentsPage";
import { PlaceholderPage } from "./features/placeholder/PlaceholderPage";
import { ProjectDetailPage } from "./features/projects/ProjectDetailPage";
import { ProjectsPage } from "./features/projects/ProjectsPage";
import { RunsPage } from "./features/runs/RunsPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { TeamEditorPage } from "./features/teams/TeamEditorPage";
import { TeamsPage } from "./features/teams/TeamsPage";
import { useSettingsStore } from "./stores/settings";
import { initializeCoreState } from "./lib/core-bootstrap";
import { buildThemeCss, getTheme, SYSTEM_THEME_ID } from "./lib/themes";

/** Style element holding the active theme's generated CSS (registry-driven). */
function ensureThemeStyleElement(): HTMLStyleElement {
  let el = document.head.querySelector<HTMLStyleElement>("style[data-theme-style]");
  if (!el) {
    el = document.createElement("style");
    el.setAttribute("data-theme-style", "");
    // Appended last so generated theme rules win ties over the bundle CSS.
    document.head.appendChild(el);
  }
  return el;
}

/** Applies the active theme (registry), dark class + <html lang> to the root. */
function useDocumentPreferences(): void {
  const theme = useSettingsStore((state) => state.theme);
  const customThemes = useSettingsStore((state) => state.customThemes);
  const locale = useSettingsStore((state) => state.locale);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const styleEl = ensureThemeStyleElement();
    const apply = (): void => {
      // "system" (or an unknown id) resolves to no definition: base palettes
      // from global.css drive light/dark via the media query.
      const def = theme === SYSTEM_THEME_ID ? undefined : getTheme(theme, customThemes);
      const dark = def ? def.base === "dark" : media.matches;
      root.classList.toggle("dark", dark);
      if (def) {
        root.dataset.theme = def.id;
      } else {
        delete root.dataset.theme;
      }
      root.style.colorScheme = dark ? "dark" : "light";
      styleEl.textContent = def ? buildThemeCss(def) : "";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, customThemes]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
}

export default function App(): JSX.Element {
  useDocumentPreferences();
  const reduceMotion = useSettingsStore((state) => state.reduceMotion);

  useEffect(() => {
    void initializeCoreState().catch((error) => console.error("Failed to initialize Core Daemon state", error));
  }, []);

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      <TooltipProvider>
        <AppShell>
          <Routes>
            {/* F-023: chat-first — the workbench is the default entry */}
            <Route path="/" element={<Navigate to="/sessions" replace />} />
            {/* Code/Work workbenches are rendered keep-alive by AppShell so a
                mode switch never remounts them; the routes only mark the URL. */}
            <Route path="/sessions" element={null} />
            <Route path="/work" element={null} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/teams" element={<TeamsPage />} />
            <Route path="/teams/:teamId" element={<TeamEditorPage />} />
            <Route
              path="/tasks"
              element={
                <PlaceholderPage
                  icon={Workflow}
                  titleKey="placeholder.tasks.title"
                  descKey="placeholder.tasks.desc"
                />
              }
            />
            <Route path="/runs" element={<RunsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/sessions" replace />} />
          </Routes>
        </AppShell>
        <Toaster />
        <ImageLightbox />
        <FilePreviewDrawer />
      </TooltipProvider>
    </MotionConfig>
  );
}
