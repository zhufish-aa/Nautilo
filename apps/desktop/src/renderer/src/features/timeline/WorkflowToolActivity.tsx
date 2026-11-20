import { useContext, useEffect, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { Session } from "@agenthub/domain";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { loadLinkedSession } from "../../lib/orchestration-runtime";
import { useAgentsStore } from "../../stores/agents";
import { useSessionsStore } from "../../stores/sessions";
import { useTeamsStore } from "../../stores/teams";
import { WorkflowDispatchContext, workflowRecord, workflowTargetName, type WorkflowDispatch } from "../workflows/workflow-dispatch";
import { ProcessDisclosure } from "./ProcessDisclosure";
import "./workflow-tool-activity.css";

const toolLabels = {
  submit: ["提交节点结果", "Submit node result"],
  propose: ["提交流程计划", "Propose workflow plan"],
  plan_context: ["读取流程与团队", "Read workflow and team"],
  run: ["启动工作流", "Start workflow"],
  spawn: ["启动子流程", "Start subworkflow"],
  status: ["查看执行进度", "Read execution progress"],
  templates: ["读取流程库", "Read workflow library"],
  schema: ["读取流程规则", "Read workflow rules"],
  agents: ["读取可用 Harness", "Read available Harnesses"],
} as const;

type WorkflowTool = keyof typeof toolLabels;

export function workflowTool(name: string): WorkflowTool | undefined {
  const action = /(?:^|[.:/]|__|nautilo_runtime_)agenthub_workflow_([a-z_]+)$/i.exec(name)?.[1]
    ?? /(?:^|[.:/]|__)nautilo_workflow_[0-9a-f]{32}(?:[.:/]|__)workflow_([a-z_]+)$/i.exec(name)?.[1];
  const key = action?.toLowerCase();
  return key && Object.hasOwn(toolLabels, key) ? key as WorkflowTool : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  return workflowRecord(value);
}

function receipt(value: unknown, depth = 0): Record<string, unknown> | undefined {
  const record = objectValue(value);
  if (!record || depth >= 3 || record.isError === true || record.success === false) return record;
  const content = Array.isArray(record.content)
    ? record.content.find((item) => objectValue(item)?.type === "text")?.text
    : record.content;
  return receipt(record.structuredContent ?? content, depth + 1) ?? record;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function submissionRoutes(dispatch: WorkflowDispatch | undefined, branches: string[], attempt: number | undefined, zh: boolean) {
  return branches.map(outlet => {
    if (!dispatch) return { outlet };
    const { run, instance } = dispatch;
    const source = run.definition.nodes.find(node => node.id === instance.nodeId);
    const port = source?.exits.find(exit => exit.name === outlet);
    const edge = port && run.definition.edges.find(edge => edge.from[0] === instance.nodeId && edge.from[1] === port.id);
    if (!port || !edge) return { outlet };
    const traversal = attempt === undefined || attempt === instance.attempt ? run.events.find(event =>
      event.type === "edge.traversed" && event.instanceId === instance.id && workflowRecord(event.data)?.branch === port.id) : undefined;
    const targetId = text(workflowRecord(traversal?.data)?.target) ?? edge.to;
    const node = run.definition.nodes.find(node => node.id === targetId);
    const isReturn = targetId === "$return" || targetId === "$return_needs_decision";
    const next = run.instances.find(candidate => {
      const incoming = workflowRecord(candidate.incoming);
      return candidate.nodeId === targetId && candidate.sessionId && incoming?.instanceId === instance.id
        && (attempt === undefined || incoming.attempt === undefined || incoming.attempt === attempt);
    });
    return { outlet, targetId, target: workflowTargetName(run, targetId, zh), sessionId: isReturn ? run.sessionId : next?.sessionId,
      agentId: node?.kind === "agent" && node.role ? run.bindings?.[node.role]?.agentInstanceId : undefined };
  });
}

export function WorkflowToolActivity({ action, name, sessionId, runId, input, output, status, zh }: {
  action: WorkflowTool; name: string; sessionId: string; runId?: string; input?: unknown; output?: string;
  status: "running" | "done" | "failed"; zh: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const session = useSessionsStore(state => state.sessions.find(item => item.id === sessionId));
  const target = session?.target;
  const memberAgent = useTeamsStore(state => target?.type === "member"
    ? state.teams.find(team => team.id === target.teamId)?.members.find(member => member.id === target.memberId)?.agentInstanceId : undefined);
  const args = useMemo(() => objectValue(input), [input]);
  const response = useMemo(() => receipt(output), [output]);
  const { dispatches, runs } = useContext(WorkflowDispatchContext);
  const scopedRun = runId ? runs.find(run => run.id === runId) : undefined;
  const sourceId = scopedRun?.agentInstanceId ?? (target?.type === "agent" ? target.instanceId : memberAgent);
  const instanceId = text(args?.instanceId) ?? text(response?.instanceId) ?? scopedRun?.workflow?.instanceId;
  const dispatch = instanceId ? dispatches.find(item => item.instance.id === instanceId) : undefined;
  const parentEvents = useSessionsStore(state => dispatch ? state.events[dispatch.run.sessionId] : undefined);
  const workflowId = dispatch?.run.id;
  const plan = useMemo(() => {
    const row = parentEvents?.find(event => event.data.kind === "workflow_plan" && event.data.plan.runId === workflowId);
    return row?.data.kind === "workflow_plan" ? row.data.plan : undefined;
  }, [parentEvents, workflowId]);
  const branch = text(args?.branch);
  const branches = branch ? [branch] : Array.isArray(args?.branches)
    ? args.branches.map(text).filter((value): value is string => !!value) : [];
  const attempt = typeof args?.attempt === "number" ? args.attempt : scopedRun?.workflow?.attempt;
  const routes = action === "submit" ? submissionRoutes(dispatch, branches, attempt, zh) : [];
  const agents = useAgentsStore(state => state.instances);
  const providerId = agents.find(instance => instance.id === sourceId)?.providerId;
  const next = routes[0];
  const nextSessionId = next?.sessionId;
  const [nextSession, setNextSession] = useState<Session>();
  useEffect(() => {
    if (!nextSessionId) return;
    let active = true;
    void loadLinkedSession(nextSessionId).then(detail => { if (active) setNextSession(detail); }).catch(() => undefined);
    return () => { active = false; };
  }, [nextSessionId]);
  const plannedKey = next?.targetId?.replace(/~/g, "~0").replace(/\//g, "~1");
  const planned = plan?.nodes.find(node => node.key === plannedKey);
  const nextId = (nextSession?.id === nextSessionId ? nextSession?.agentInstanceId : undefined)
    ?? planned?.assignment.agentInstanceId ?? next?.agentId;
  const nextProvider = agents.find(instance => instance.id === nextId)?.providerId;
  const result = objectValue(args?.result);
  const destination = next ? routes.map(route => [route.outlet, route.target].filter(Boolean).join(" → ")).join(" · ")
    : text(objectValue(response?.template)?.name) ?? text(objectValue(response?.definition)?.name);
  const summary = text(result?.summary) ?? text(response?.summary) ?? text(args?.summary);
  const evidence = Array.isArray(result?.evidence) ? result.evidence.map(text).filter((item): item is string => !!item) : [];
  const pending = response?.status === "pending" || response?.approvalRequired === true;
  const failed = status === "failed" || response?.accepted === false && !pending || response?.isError === true || response?.success === false;
  const accepted = response?.accepted === true;
  const state = failed ? (zh ? "未通过" : "Failed") : status === "running" ? (zh ? "进行中" : "In progress")
    : pending ? (zh ? "待审核" : "Awaiting review") : accepted ? (zh ? "已接收" : "Accepted")
      : (zh ? "已完成" : "Completed");

  const routePreview = next && <span className="workflow-tool-route">
    <ArrowRight size={13} aria-hidden />
    <span className="workflow-tool-outlet"><small>{zh ? "出口" : "Outlet"}</small><span>{next.outlet}</span></span>
    {next.target && <><ArrowRight size={13} aria-hidden />{nextProvider && <ProviderAvatar providerId={nextProvider} size="sm" />}
      <span className="workflow-tool-node">{next.target}</span></>}
    {routes.length > 1 && <small className="workflow-tool-more">+{routes.length - 1}</small>}
  </span>;
  return <ProcessDisclosure className="workflow-tool-activity" icon={providerId && <ProviderAvatar providerId={providerId} size="sm" />}
    label={toolLabels[action][zh ? 0 : 1]} preview={routePreview ?? destination} previewTitle={destination}
    accessory={<span className="workflow-tool-receipt" data-tone={failed ? "failed" : pending || status === "running" ? "pending" : "done"}>{state}</span>}
    retainPreview running={status === "running"} failed={failed} open={open} onToggle={() => setOpen(value => !value)}>
    <div className="workflow-tool-detail">
      {routes.length > 1 && <ul className="workflow-tool-routes" aria-label={zh ? "所选出口" : "Selected outlets"}>{routes.map(route =>
        <li key={route.outlet}>{route.outlet}{route.target && <> <ArrowRight size={12} aria-hidden /> {route.target}</>}</li>)}</ul>}
      {summary && <p>{summary}</p>}
      {!!evidence.length && <ul aria-label={zh ? "证据" : "Evidence"}>{evidence.map((item, index) => <li key={index}>{item}</li>)}</ul>}
      <details className="workflow-tool-raw">
        <summary>{zh ? "技术详情" : "Technical details"}</summary>
        <code>{name}</code>
        {input != null && <pre>{args ? JSON.stringify(args, null, 2) : String(input)}</pre>}
        {output && <pre>{output}</pre>}
      </details>
    </div>
  </ProcessDisclosure>;
}
