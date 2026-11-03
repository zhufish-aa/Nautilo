import { create } from "zustand";
import type {
  Project,
  ProjectInspection,
  VerificationCommandTemplate,
  WorkspaceMode
} from "@agenthub/domain";
import { requestCore } from "../lib/bridge";
import { toDomainProject, toUiProject } from "../lib/core-mappers";
import { normalizePath } from "../lib/utils";
import type { ActiveRunSummary, UiProject } from "../lib/types";

interface ProjectsState {
  projects: UiProject[];
  hydrate: (inspect?: boolean) => Promise<void>;
  addProject: (rootPath: string, name?: string) => Promise<UiProject | "duplicate">;
  removeProject: (id: string) => Promise<void>;
  rescanProject: (id: string) => Promise<void>;
  touchProject: (id: string) => void;
  setActiveRun: (id: string, activeRun: ActiveRunSummary | undefined) => void;
  setVerificationTemplates: (id: string, templates: VerificationCommandTemplate[]) => Promise<void>;
  setWorkspaceMode: (id: string, mode: WorkspaceMode) => Promise<void>;
  setNonGitDiffMode: (id: string, mode: NonNullable<Project["nonGitDiffMode"]>) => Promise<void>;
}

// Settings share a full-project upsert. Serialize edits for each project so a
// second control builds its payload from the first saved change, not stale UI.
const projectSaves = new Map<string, Promise<void>>();
function saveProjectInOrder(id: string, save: () => Promise<void>): Promise<void> {
  const previous = projectSaves.get(id) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(save);
  projectSaves.set(id, pending);
  return pending.finally(() => {
    if (projectSaves.get(id) === pending) projectSaves.delete(id);
  });
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],

  hydrate: async (inspect = true) => {
    const projects = await requestCore<Project[]>("project.list");
    // Seed only missing rows. A list response may predate a saved setting.
    set((state) => ({ projects: [
      ...state.projects,
      ...projects.filter((project) => !state.projects.some((item) => item.id === project.id))
        .map((project) => toUiProject(project))
    ] }));
    if (inspect) await Promise.all(projects.map((project) => get().rescanProject(project.id).catch(() => {})));
  },

  addProject: async (rootPath, name) => {
    const normalized = normalizePath(rootPath);
    if (get().projects.some((project) => normalizePath(project.rootPath) === normalized))
      return "duplicate";
    const project = await requestCore<Project>("project.add", {
      rootPath: rootPath.trim(),
      name: name?.trim() || undefined
    });
    const pending = { ...toUiProject(project), scanning: true };
    set((state) => ({ projects: [pending, ...state.projects] }));
    await get().rescanProject(project.id);
    return get().projects.find((item) => item.id === project.id) ?? pending;
  },

  removeProject: (id) => saveProjectInOrder(id, async () => {
    await requestCore<{ removed: true }>("project.remove", { projectId: id });
    set((state) => ({ projects: state.projects.filter((project) => project.id !== id) }));
  }),

  rescanProject: (id) => saveProjectInOrder(id, async () => {
    if (!get().projects.some((project) => project.id === id)) return;
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id ? { ...project, scanning: true } : project
      )
    }));
    try {
      const result = await requestCore<{ project: Project; inspection: ProjectInspection }>(
        "project.scan",
        { projectId: id }
      );
      set((state) => ({
        projects: state.projects.map((item) =>
          item.id === id ? toUiProject(result.project, result.inspection, item) : item
        )
      }));
    } catch (error) {
      set((state) => ({
        projects: state.projects.map((project) =>
          project.id === id ? { ...project, scanning: false } : project
        )
      }));
      throw error;
    }
  }),

  touchProject: (id) =>
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id ? { ...project, lastOpenedAt: new Date().toISOString() } : project
      )
    })),

  setActiveRun: (id, activeRun) =>
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id ? { ...project, activeRun } : project
      )
    })),

  setVerificationTemplates: (id, verificationTemplates) =>
    saveProjectInOrder(id, async () => {
      const current = get().projects.find((project) => project.id === id);
      if (!current) return;
      const saved = await requestCore<Project>("project.upsert", {
        ...toDomainProject(current),
        verificationTemplates
      });
      set((state) => ({
        projects: state.projects.map((project) =>
          project.id === id
            ? { ...project, verificationTemplates: saved.verificationTemplates ?? [] }
            : project
        )
      }));
    }),

  setWorkspaceMode: (id, workspaceMode) =>
    saveProjectInOrder(id, async () => {
      const current = get().projects.find((project) => project.id === id);
      if (!current) return;
      const saved = await requestCore<Project>("project.upsert", {
        ...toDomainProject(current),
        workspaceMode
      });
      set((state) => ({
        projects: state.projects.map((project) =>
          project.id === id
            ? { ...project, workspaceMode: saved.workspaceMode ?? "direct" }
            : project
        )
      }));
    }),

  setNonGitDiffMode: (id, nonGitDiffMode) =>
    saveProjectInOrder(id, async () => {
      const current = get().projects.find((project) => project.id === id);
      if (!current) throw new Error("Project not found");
      const saved = await requestCore<Project>("project.upsert", {
        ...toDomainProject(current),
        nonGitDiffMode
      });
      // Keep the last persisted selection while saving. Failed requests cannot
      // leave the UI claiming that snapshot collection was disabled.
      set((state) => ({
        projects: state.projects.map((project) =>
          project.id === id
            ? { ...project, nonGitDiffMode: saved.nonGitDiffMode ?? "full" }
            : project
        )
      }));
    })
}));
