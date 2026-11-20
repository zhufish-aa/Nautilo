import { create } from "zustand";
import type { WorkflowTemplate, WorkflowRun } from "@agenthub/domain";
import { requestCore } from "../lib/bridge";

type Summary = Pick<WorkflowRun, "id" | "revision" | "sessionId" | "projectId" | "status" | "createdAt" | "updatedAt"> & { name?: string; definitionId: string };
interface WorkflowsState {
  templates: WorkflowTemplate[]; runs: Summary[]; loaded: boolean;
  load(): Promise<void>;
  loadTemplates(): Promise<void>;
  save(input: Omit<WorkflowTemplate, "createdAt" | "updatedAt">): Promise<WorkflowTemplate>;
  observe(run: WorkflowRun): void;
}
export const useWorkflowsStore = create<WorkflowsState>((set) => ({
  templates: [], runs: [], loaded: false,
  observe(run) {
    set(state => {
      if (state.runs.find(item => item.id === run.id)?.revision === run.revision) return state;
      const summary: Summary = { id: run.id, revision: run.revision, sessionId: run.sessionId, projectId: run.projectId, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt, name: run.definition.name, definitionId: run.definition.id };
      return { runs: [summary, ...state.runs.filter(item => item.id !== run.id)] };
    });
  },
  async load() {
    const [templates, runs] = await Promise.all([requestCore<WorkflowTemplate[]>("workflow.templates"), requestCore<Summary[]>("workflow.list", {})]);
    set({ templates, runs, loaded: true });
  },
  async loadTemplates() {
    const templates = await requestCore<WorkflowTemplate[]>("workflow.templates");
    set({ templates, loaded: true });
  },
  async save(input) {
    const saved = await requestCore<WorkflowTemplate>("workflow.save", input);
    set(state => ({ templates: [saved, ...state.templates.filter(template => template.id !== saved.id)] }));
    return saved;
  }
}));
