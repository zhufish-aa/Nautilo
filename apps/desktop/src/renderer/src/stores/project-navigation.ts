import { create } from "zustand";
import { persist } from "zustand/middleware";

type ProjectReading = { lastSessionId?: string };
interface ProjectNavigation {
  projects: Record<string, ProjectReading>;
  position?: { key: string; offset: number };
  remember: (id: string, patch: ProjectReading) => void;
  rememberPosition: (position: ProjectNavigation["position"]) => void;
}

/** Only navigation identifiers live here; conversation text stays in the daemon. */
export const useProjectNavigation = create<ProjectNavigation>()(persist((set) => ({
  projects: {},
  remember: (id, patch) => set(state => ({ projects: Object.fromEntries(
    [...Object.entries(state.projects).filter(([key]) => key !== id), [id, { ...state.projects[id], ...patch }]].slice(-200)
  ) })),
  rememberPosition: position => set({ position })
}), { name: "nautilo.project-navigation", version: 1 }));
