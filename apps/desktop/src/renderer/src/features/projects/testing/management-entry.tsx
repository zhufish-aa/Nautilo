/** Test-only renderer entry. Never imported by production. */
import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Routes, Route } from "react-router-dom";
import { I18nProvider } from "../../../lib/i18n";
import { TooltipProvider } from "../../../components/ui/Tooltip";
import { useProjectsStore } from "../../../stores/projects";
import { useTeamsStore } from "../../../stores/teams";
import { useAgentsStore } from "../../../stores/agents";
import { useSessionsStore } from "../../../stores/sessions";
import { useSettingsStore } from "../../../stores/settings";
import { useInteractionsStore } from "../../../stores/interactions";
import { ProjectsPage } from "../../../features/projects/ProjectsPage";
import { ProjectDetailPage } from "../../../features/projects/ProjectDetailPage";
import { TeamsPage } from "../../../features/teams/TeamsPage";
import { TeamEditorPage } from "../../../features/teams/TeamEditorPage";
import { TasksPage } from "../../../features/tasks/TasksPage";
import { RunsPage } from "../../../features/runs/RunsPage";
import { OnboardingTour } from "../../../features/onboarding/OnboardingTour";
const managementQa = {
  projects: useProjectsStore,
  teams: useTeamsStore,
  agents: useAgentsStore,
  sessions: useSessionsStore,
  settings: useSettingsStore,
  interactions: useInteractionsStore
};
declare global {
  interface Window {
    managementQa: typeof managementQa;
  }
}
window.managementQa = managementQa;
useSettingsStore.setState({ onboardingCompleted: true, locale: "zh-CN", reduceMotion: true });
createRoot(document.getElementById("root")!).render(
  <HashRouter>
    <I18nProvider>
      <TooltipProvider>
        <Routes>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/teams/:teamId" element={<TeamEditorPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route
            path="/sessions"
            element={
              <div>
                <textarea className="composer" data-tour="sessions-composer" />
                <button data-tour="session-project">项目</button>
                <button data-tour="session-agent">Agent</button>
              </div>
            }
          />
        </Routes>
        <OnboardingTour />
      </TooltipProvider>
    </I18nProvider>
  </HashRouter>
);
