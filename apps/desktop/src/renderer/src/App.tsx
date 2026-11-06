import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppShell } from "./components/layout/AppShell";
import { Toaster } from "./components/ui/Toaster";
import { TooltipProvider } from "./components/ui/Tooltip";
import { ImageLightbox } from "./features/timeline/ImageLightbox";
import { FilePreviewDrawer } from "./features/timeline/FilePreviewDrawer";
import { OnboardingTour } from "./features/onboarding/OnboardingTour";

import { useSettingsStore } from "./stores/settings";
import { initializeCoreState } from "./lib/core-bootstrap";
import { buildThemeCss, getTheme, SYSTEM_THEME_ID } from "./lib/themes";

const AgentsPage = lazy(() => import("./features/agents/AgentsPage").then((module) => ({ default: module.AgentsPage })));
const ProjectDetailPage = lazy(() => import("./features/projects/ProjectDetailPage").then((module) => ({ default: module.ProjectDetailPage })));
const ProjectsPage = lazy(() => import("./features/projects/ProjectsPage").then((module) => ({ default: module.ProjectsPage })));
const RunsPage = lazy(() => import("./features/runs/RunsPage").then((module) => ({ default: module.RunsPage })));
const SettingsPage = lazy(() => import("./features/settings/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const TasksPage = lazy(() => import("./features/tasks/TasksPage").then((module) => ({ default: module.TasksPage })));
const TeamEditorPage = lazy(() => import("./features/teams/TeamEditorPage").then((module) => ({ default: module.TeamEditorPage })));
const TeamsPage = lazy(() => import("./features/teams/TeamsPage").then((module) => ({ default: module.TeamsPage })));

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
  const locale = useSettingsStore((state) => state.locale);

  useEffect(() => {
    document.documentElement.toggleAttribute("data-reduce-motion", reduceMotion);
    return () => document.documentElement.removeAttribute("data-reduce-motion");
  }, [reduceMotion]);

  useEffect(() => {
    void initializeCoreState().catch((error) => console.error("Failed to initialize Core Daemon state", error));
  }, []);

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      <TooltipProvider>
        <AppShell>
          <Suspense fallback={<div role="status" aria-label={locale === "zh-CN" ? "正在加载" : "Loading"} className="p-6">
            <div className="h-5 w-32 rounded bg-panel motion-safe:animate-pulse" />
          </div>}>
            <Routes>
              {/* F-023: chat-first — the workbench is the default entry */}
              <Route path="/" element={<Navigate to="/sessions" replace />} />
              {/* One workspace is kept alive by AppShell. /work is a legacy alias;
                  neither route creates a second instance or changes saved modes. */}
              <Route path="/sessions" element={null} />
              <Route path="/work" element={null} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
              <Route path="/agents" element={<Navigate to="/settings?section=agents" replace />} />
              <Route path="/teams" element={<TeamsPage />} />
              <Route path="/teams/:teamId" element={<TeamEditorPage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/runs" element={<RunsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/sessions" replace />} />
            </Routes>
          </Suspense>
        </AppShell>
        <Toaster />
        <OnboardingTour />
        <ImageLightbox />
        <FilePreviewDrawer />
      </TooltipProvider>
    </MotionConfig>
  );
}
