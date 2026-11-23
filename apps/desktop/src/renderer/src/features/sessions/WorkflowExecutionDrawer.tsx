import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowUpRight, Workflow } from "lucide-react";
import { Link } from "react-router-dom";
import type { IpcRequestMap } from "@agenthub/schemas";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { WorkspaceDrawer } from "./WorkspaceDrawer";
import "./workflow-execution-drawer.css";

const WorkflowInspection = lazy(() => import("../workflows/WorkflowsPage").then(module => ({ default: module.WorkflowsPage })));

export function WorkflowExecutionDrawer({ sessionId, runId, onClose, onOpenSession }: {
  sessionId: string; runId?: string; onClose: () => void; onOpenSession: (id: string) => void;
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const title = zh ? "工作流执行" : "Workflow execution";
  const [latest, setLatest] = useState<string | null>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (runId) return;
    let current = true;
    void requestCore<IpcRequestMap["workflow.list"]["output"]>("workflow.list", { sessionId }).then(runs => {
      if (current) setLatest(runs[0]?.id ?? null);
    }, reason => { if (current) setError(String(reason)); });
    return () => { current = false; };
  }, [runId, sessionId]);
  const selectedRun = runId ?? latest;
  const loading = zh ? "正在读取执行记录…" : "Loading execution…";
  const query = new URLSearchParams({ session: sessionId });
  if (selectedRun) query.set("run", selectedRun);
  const fullView = zh ? "打开工作流页面" : "Open workflows page";
  return <WorkspaceDrawer open title={title} onClose={onClose} defaultWidth={724} minWidth={440} adjacentMinWidth={420}
    resizable storageKey="nautilo.workflow.execution.width" className="workflow-execution-drawer" animateReview="slide"
    headerActions={<Link className="workspace-panel-icon" aria-label={fullView} title={fullView} to={`/workflows?${query}`}><ArrowUpRight size={15} aria-hidden /></Link>}
    headerContent={<h2 className="workflow-execution-heading"><Workflow size={15} aria-hidden />{title}</h2>}>
    {selectedRun ? <Suspense fallback={<div role="status" className="workflow-inspection-loading">{loading}</div>}>
      <WorkflowInspection inspection={{ runId: selectedRun, onOpenSession }} />
    </Suspense> : <div className="workflow-inspection-loading" role={error ? "alert" : "status"}>
      {error || (latest === null ? (zh ? "此会话暂无工作流执行记录" : "No workflow executions for this conversation") : loading)}
    </div>}
  </WorkspaceDrawer>;
}
