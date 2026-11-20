import { createContext, useEffect, useState } from "react";
import type { AgentRun, WorkflowInstance, WorkflowRun } from "@agenthub/domain";
import { requestCore } from "../../lib/bridge";
import { nodeLabel } from "./workflow-model";

type ScopedRun = AgentRun & { workflow?: { runId?: string; instanceId?: string; attempt?: number } };
export interface WorkflowDispatch {
  run: WorkflowRun;
  instance: WorkflowInstance;
}

const empty = { dispatches: [] as WorkflowDispatch[], runs: [] as ScopedRun[] };
export const WorkflowDispatchContext = createContext(empty);

export function useWorkflowDispatches(sessionId: string, enabled: boolean, activeRunId?: string, status?: string): typeof empty {
  const [state, setState] = useState<typeof empty & { sessionId: string }>();
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: number | undefined;
    const graphs = new Map<string, WorkflowRun>();
    let runs: ScopedRun[] | undefined;
    const refresh = async (): Promise<void> => {
      try {
        runs ??= await requestCore<ScopedRun[]>("run.list", { sessionId });
        if (disposed) return;
        const ids = new Set(runs.flatMap(({ workflow }) => workflow?.runId && workflow.instanceId ? [workflow.runId] : []));
        const requests = [...ids].filter(id => {
          const graph = graphs.get(id);
          return !graph || ["running", "paused", "finalizing"].includes(graph.status);
        });
        await Promise.allSettled(requests.map(async id => {
          const graph = await requestCore<WorkflowRun>("workflow.get", { runId: id });
          if (graph.id === id) graphs.set(id, graph);
        }));
        if (disposed) return;
        const dispatches = [...graphs.values()].flatMap(run => run.instances
          .filter(instance => instance.sessionId === sessionId)
          .map(instance => ({ run, instance })))
          .sort((a, b) => a.instance.createdAt - b.instance.createdAt);
        const active = dispatches.some(({ run }) => ["running", "paused", "finalizing"].includes(run.status));
        setState({ sessionId, dispatches, runs });
        if (!active) return;
      } catch { /* A reconnect or a new turn can refresh the history. */ }
      if (!disposed) timer = window.setTimeout(() => void refresh(), document.hidden ? 10000 : 1500);
    };
    void refresh();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [sessionId, enabled, activeRunId, status]);
  return enabled && state?.sessionId === sessionId ? state : empty;
}

export function workflowRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function workflowTargetName(run: WorkflowRun, id: string, zh: boolean): string {
  if (id === "$return") return zh ? "交回主会话" : "Return to main conversation";
  if (id === "$return_needs_decision") return zh ? "交回判断" : "Return for a decision";
  const node = run.definition.nodes.find(node => node.id === id);
  return node ? nodeLabel(node) : id;
}

export function workflowDispatchPrompt({ run, instance }: WorkflowDispatch): string | undefined {
  const activation = run.events.find(event => event.type === "node.activated" && event.instanceId === instance.id);
  const prompt = workflowRecord(activation?.data)?.prompt;
  return instance.taskText ?? (typeof prompt === "string" ? prompt : instance.prompt?.split("\n\n[NAUTILO_WORKFLOW_NODE]")[0].trim());
}
