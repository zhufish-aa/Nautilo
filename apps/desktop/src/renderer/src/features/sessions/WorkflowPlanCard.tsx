import { useRef, useState } from "react";
import { Check, ChevronDown, Clock3, PanelRightOpen, Play, RotateCcw, Workflow, X } from "lucide-react";
import { create } from "zustand";
import type { WorkflowPlan, WorkflowPlanAssignment } from "@agenthub/domain";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { useAgentsStore } from "../../stores/agents";
import { useComposerDraftsStore } from "../../stores/composer-drafts";
import { connectionModelKey, useConnectionsStore } from "../../stores/connections";
import { useSessionsStore } from "../../stores/sessions";
import { SessionModelControl, type ComposerConfiguration } from "./SessionModelControl";
import "./workflow-plan.css";

type Assignments = Record<string, WorkflowPlanAssignment>;
const NO_EDITS: Assignments = {};
const usePlanEdits = create<{ edits: Record<string, Assignments> }>(() => ({ edits: {} }));
const executionLabels: Record<string, [string, string]> = {
  running: ["执行中", "Running"], paused: ["已暂停", "Paused"], finalizing: ["收尾中", "Finalizing"],
  completed: ["已完成", "Completed"], failed: ["执行失败", "Failed"], cancelled: ["已停止", "Stopped"],
  needs_decision: ["待处理", "Needs attention"]
};

export function WorkflowPlanCard({ plan, runStatus, onViewExecution }: { plan: WorkflowPlan; runStatus?: string; onViewExecution?: (id: string) => void }) {
  const zh = useI18n().locale === "zh-CN";
  const instances = useAgentsStore(state => state.instances);
  const modelCatalogs = useAgentsStore(state => state.modelCatalogs);
  const connectionCatalogs = useConnectionsStore(state => state.modelCatalogs);
  const archived = useSessionsStore(state => state.sessions.find(session => session.id === plan.sessionId)?.status === "archived");
  const edits = usePlanEdits(state => state.edits[plan.id] ?? NO_EDITS);
  const [resolved, setResolved] = useState<WorkflowPlan>();
  const shown = plan.status === "pending" ? resolved ?? plan : plan;
  const pending = shown.status === "pending";
  const [expanded, setExpanded] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject">();
  const sending = useRef(false);
  const enabled = instances.filter(item => item.enabled && item.status !== "disabled" && item.configurationKind === "harness");
  const selected = (key: string, base: WorkflowPlanAssignment) => pending ? edits[key] ?? base : base;
  const mutate = (key: string, assignment: WorkflowPlanAssignment) => {
    setError("");
    usePlanEdits.setState(state => ({
      edits: { ...state.edits, [plan.id]: { ...state.edits[plan.id], [key]: assignment } }
    }));
  };
  const decide = async (action: "approve" | "reject") => {
    if (sending.current || !pending || archived) return;
    sending.current = true;
    setBusy(action);
    setError("");
    try {
      const updated = await requestCore<WorkflowPlan>("workflow.plan.decide", {
        sessionId: plan.sessionId, planId: plan.id, action, ...(action === "approve" ? { assignments: edits } : {})
      });
      setResolved(updated);
      usePlanEdits.setState(state => {
        const next = { ...state.edits };
        delete next[plan.id];
        return { edits: next };
      });
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : String(failure);
      setError(detail.replace(/^Error invoking remote method '[^']+': Error:\s*/i, ""));
    } finally {
      sending.current = false;
      setBusy(undefined);
    }
  };
  const StatusIcon = pending ? Clock3 : shown.status === "approved" ? Check : X;
  const execution = shown.runId && runStatus ? executionLabels[runStatus]?.[zh ? 0 : 1] : undefined;
  const status = pending ? (zh ? "待确认" : "Awaiting approval")
    : shown.status === "approved" ? execution ?? (zh ? "已确认" : "Approved") : (zh ? "已拒绝" : "Rejected");
  return (
    <article className="conversation-workflow-plan" data-status={shown.status} aria-label={zh ? "工作流执行计划" : "Workflow execution plan"}>
      <header className="workflow-plan-heading">
        <span className="workflow-plan-mark"><Workflow size={17} aria-hidden /></span>
        <div className="workflow-plan-title">
          <small>{zh ? "执行计划" : "Execution plan"} · {zh ? `${shown.nodes.length} 个执行项` : `${shown.nodes.length} assignments`}</small>
          <h3>{shown.template.name}</h3>
        </div>
        <span className="workflow-plan-status" role="status"><StatusIcon size={12} aria-hidden />{status}</span>
      </header>
      {shown.summary && <p className="workflow-plan-summary">{shown.summary}</p>}
      {!!shown.nodes.length && <ul className="workflow-plan-steps">
        {shown.nodes.map(node => {
          const assignment = selected(node.key, node.assignment);
          const instance = instances.find(item => item.id === assignment.agentInstanceId);
          const defaultModel = zh ? "默认模型" : "Default model";
          const modelCatalog = assignment.connectionId && assignment.connectionRevision
            ? connectionCatalogs[connectionModelKey(assignment.connectionId, assignment.connectionRevision)]
            : modelCatalogs[assignment.agentInstanceId];
          const modelName = modelCatalog?.models.find(model => model.id === assignment.model)?.displayName;
          const open = expanded === node.key;
          const configure = (patch: ComposerConfiguration) => mutate(node.key, {
            ...assignment, ...patch,
            ...("connectionId" in patch && !patch.connectionId ? { connectionId: null, connectionRevision: null } : {})
          });
          return <li key={node.key}>
            <button type="button" className="workflow-plan-step" aria-expanded={open} onClick={() => setExpanded(open ? undefined : node.key)}>
              <span><strong>{node.name}</strong><small>{[node.scope, node.memberName || node.role].filter(Boolean).join(" · ")}</small></span>
              <span><strong>{instance?.displayName ?? assignment.agentInstanceId}</strong><small>{modelName || assignment.model || defaultModel}</small></span>
              <ChevronDown size={15} aria-hidden />
            </button>
            {open && <div className="workflow-plan-step-body">
              {node.task && <p className="workflow-plan-task">{node.task}</p>}
              {pending && <div className="workflow-plan-configuration">
                <label><span>Harness</span><select aria-label={zh ? `${node.name}的 Harness` : `Harness for ${node.name}`}
                  value={assignment.agentInstanceId} disabled={!!busy || archived} onChange={event => {
                    const id = event.target.value;
                    mutate(node.key, id === node.assignment.agentInstanceId ? node.assignment : {
                      agentInstanceId: id, connectionId: null, connectionRevision: null, model: "", reasoningEffort: "", serviceTier: ""
                    });
                  }}>
                  {!enabled.some(item => item.id === assignment.agentInstanceId) &&
                    <option value={assignment.agentInstanceId}>{instance?.displayName ?? assignment.agentInstanceId}</option>}
                  {enabled.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}
                </select></label>
                <SessionModelControl disabled={!!busy || archived} inline draft={{
                  instanceId: assignment.agentInstanceId,
                  configuration: { ...assignment, connectionId: assignment.connectionId ?? undefined, connectionRevision: assignment.connectionRevision ?? undefined },
                  onChange: configure
                }}/>
              </div>}
            </div>}
          </li>;
        })}
      </ul>}
      {error && <p role="alert" className="workflow-plan-error">{error}</p>}
      {(pending || shown.runId && onViewExecution || shown.status === "rejected" && !archived) && <footer className="workflow-plan-footer">
        {pending ? <>
          <button type="button" disabled={!!busy || archived} onClick={() => void decide("reject")}>{busy === "reject" ? (zh ? "正在拒绝…" : "Rejecting…") : (zh ? "拒绝" : "Reject")}</button>
          <button type="button" className="workflow-plan-confirm" disabled={!!busy || archived} onClick={() => void decide("approve")}>
            <Play size={13} aria-hidden />{busy === "approve" ? (zh ? "正在启动…" : "Starting…") : (zh ? "确认执行" : "Approve and run")}
          </button>
        </> : shown.runId && onViewExecution ? <button type="button" onClick={() => onViewExecution(shown.runId!)}>
          <PanelRightOpen size={14} aria-hidden />{zh ? "查看执行" : "View execution"}
        </button> : <button type="button" onClick={() => useComposerDraftsStore.getState().setWorkflow(plan.sessionId, plan.template)}>
          <RotateCcw size={13} aria-hidden />{zh ? "重新引用" : "Reference again"}
        </button>}
      </footer>}
    </article>
  );
}
