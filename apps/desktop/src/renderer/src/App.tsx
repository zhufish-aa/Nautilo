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
import { SessionsPage } from "./features/sessions/SessionsPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { TeamEditorPage } from "./features/teams/TeamEditorPage";
import { TeamsPage } from "./features/teams/TeamsPage";
import { useSettingsStore } from "./stores/settings";
import { initializeCoreState } from "./lib/core-bootstrap";

/** Applies theme class + <html lang> to the document root. */
function useDocumentPreferences(): void {
  const theme = useSettingsStore((state) => state.theme);
  const locale = useSettingsStore((state) => state.locale);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      root.classList.toggle("dark", dark);
      root.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

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
            <Route path="/sessions" element={<SessionsPage />} />
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
