import { lazy, Suspense } from "react";
import { Workflow } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { WorkspaceDrawer } from "./WorkspaceDrawer";
import "./workflow-execution-drawer.css";

const WorkflowInspection = lazy(() => import("../workflows/WorkflowsPage").then(module => ({ default: module.WorkflowsPage })));

export function WorkflowExecutionDrawer({ runId, onClose, onOpenSession }: {
  runId: string; onClose: () => void; onOpenSession: (id: string) => void;
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const title = zh ? "工作流执行" : "Workflow execution";
  return <WorkspaceDrawer open title={title} onClose={onClose} defaultWidth={724} minWidth={440} adjacentMinWidth={420}
    resizable storageKey="nautilo.workflow.execution.width" className="workflow-execution-drawer" animateReview
    headerContent={<h2 className="workflow-execution-heading"><Workflow size={15} aria-hidden />{title}</h2>}>
    <Suspense fallback={<div role="status" className="workflow-inspection-loading">{zh ? "正在读取执行记录…" : "Loading execution…"}</div>}>
      <WorkflowInspection inspection={{ runId, onOpenSession }} />
    </Suspense>
  </WorkspaceDrawer>;
}
