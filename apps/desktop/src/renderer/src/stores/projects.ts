import { create } from "zustand";
import type { Project, ProjectInspection, VerificationCommandTemplate, WorkspaceMode } from "@agenthub/domain";
import { requestCore } from "../lib/bridge";
import { toDomainProject, toUiProject } from "../lib/core-mappers";
import { normalizePath } from "../lib/utils";
import type { ActiveRunSummary, UiProject } from "../lib/types";

interface ProjectsState {
  projects: UiProject[];
  hydrate: () => Promise<void>;
  addProject: (rootPath: string, name?: string) => Promise<UiProject | "duplicate">;
  removeProject: (id: string) => Promise<void>;
  rescanProject: (id: string) => Promise<void>;
  touchProject: (id: string) => void;
  setActiveRun: (id: string, activeRun: ActiveRunSummary | undefined) => void;
  setVerificationTemplates: (id: string, templates: VerificationCommandTemplate[]) => Promise<void>;
  setWorkspaceMode: (id: string, mode: WorkspaceMode) => Promise<void>;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],

  hydrate: async () => {
    const projects = await requestCore<Project[]>("project.list");
    const inspected = await Promise.all(projects.map(async (project) => {
      try {
        return await requestCore<{ project: Project; inspection: ProjectInspection }>("project.scan", { projectId: project.id });
      } catch {
        return { project, inspection: undefined };
      }
    }));
    set((state) => ({ projects: inspected.map(({ project, inspection }) => toUiProject(project, inspection, state.projects.find((item) => item.id === project.id))) }));
  },

  addProject: async (rootPath, name) => {
    const normalized = normalizePath(rootPath);
    if (get().projects.some((project) => normalizePath(project.rootPath) === normalized)) return "duplicate";
    const project = await requestCore<Project>("project.add", { rootPath: rootPath.trim(), name: name?.trim() || undefined });
    const pending = { ...toUiProject(project), scanning: true };
    set((state) => ({ projects: [pending, ...state.projects] }));
    try {
      const result = await requestCore<{ project: Project; inspection: ProjectInspection }>("project.scan", { projectId: project.id });
      const scanned = toUiProject(result.project, result.inspection, pending);
      set((state) => ({ projects: state.projects.map((item) => item.id === project.id ? scanned : item) }));
      return scanned;
    } catch (error) {
      set((state) => ({ projects: state.projects.map((item) => item.id === project.id ? { ...item, scanning: false } : item) }));
      throw error;
    }
  },

  removeProject: async (id) => {
    await requestCore<{ removed: true }>("project.remove", { projectId: id });
    set((state) => ({ projects: state.projects.filter((project) => project.id !== id) }));
  },

  rescanProject: async (id) => {
    set((state) => ({ projects: state.projects.map((project) => project.id === id ? { ...project, scanning: true } : project) }));
    try {
      const result = await requestCore<{ project: Project; inspection: ProjectInspection }>("project.scan", { projectId: id });
      set((state) => ({ projects: state.projects.map((item) => item.id === id ? toUiProject(result.project, result.inspection, item) : item) }));
    } catch (error) {
      set((state) => ({ projects: state.projects.map((project) => project.id === id ? { ...project, scanning: false } : project) }));
      throw error;
    }
  },

  touchProject: (id) => set((state) => ({
    projects: state.projects.map((project) => project.id === id ? { ...project, lastOpenedAt: new Date().toISOString() } : project)
  })),

  setActiveRun: (id, activeRun) => set((state) => ({
    projects: state.projects.map((project) => project.id === id ? { ...project, activeRun } : project)
  })),

  setVerificationTemplates: async (id, verificationTemplates) => {
    const current = get().projects.find((project) => project.id === id);
    if (!current) return;
    const saved = await requestCore<Project>("project.upsert", {
      id: current.id,
      name: current.name,
      rootPath: current.rootPath,
      repositoryType: current.repositoryType,
      workspaceMode: current.workspaceMode,
      defaultBranch: current.scan?.git.defaultBranch,
      frontendPaths: current.scan?.frontendPaths ?? [],
      backendPaths: current.scan?.backendPaths ?? [],
      ignoredPaths: [],
      policyId: "default",
      verificationTemplates
    });
    set((state) => ({
      projects: state.projects.map((project) => project.id === id
        ? { ...project, verificationTemplates: saved.verificationTemplates ?? [] }
        : project)
    }));
  },

  setWorkspaceMode: async (id, workspaceMode) => {
    const current = get().projects.find((project) => project.id === id);
    if (!current) return;
    const saved = await requestCore<Project>("project.upsert", {
      ...toDomainProject(current),
      workspaceMode
    });
    set((state) => ({
      projects: state.projects.map((project) => project.id === id
        ? { ...project, workspaceMode: saved.workspaceMode ?? "direct" }
        : project)
    }));
  }
}));
