import { useEffect, useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { StageActivityPill } from "../../components/layout/StageActivityPill";
import { useI18n } from "../../lib/i18n";
import type { RunLifecycle, TimelineEvent, TimelinePayload } from "../../lib/types";
import { useWorkflowsStore } from "../../stores/workflows";

interface RunActivityIndicatorProps {
  lifecycle?: RunLifecycle;
  events: TimelineEvent[];
  waitingForDelegates?: boolean;
}

export function SessionActivityPill({ lifecycle, events, waitingForDelegates, foreground, orchestration }: RunActivityIndicatorProps & {
  foreground?: RunLifecycle;
  orchestration?: RunLifecycle;
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const { runningPlan, completed } = useMemo(() => {
    let runningPlan: Extract<TimelinePayload, { kind: "workflow_plan" }> | undefined;
    const completed: string[] = [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const data = events[index].data;
      if (data.kind !== "workflow_plan" || !data.plan.runId) continue;
      if (data.runStatus === "running" || data.runStatus === "finalizing") runningPlan ??= data;
      if (data.runStatus === "completed") completed.push(data.plan.runId);
    }
    return { runningPlan, completed };
  }, [events]);
  const workflowId = runningPlan?.plan.runId;
  const workflowStart = useWorkflowsStore(state => workflowId ? state.runs.find(run => run.id === workflowId)?.createdAt : undefined);
  const completedIds = [...completed];
  if (foreground?.status === "completed") completedIds.push("foreground");
  if (orchestration?.status === "completed") completedIds.push("delegates");

  if (runningPlan && workflowId) return <StageActivityPill activity={{ id: workflowId, label: runningPlan.runStatus === "finalizing"
    ? (zh ? "工作流收尾中" : "Finishing workflow")
    : runningPlan.plan.template.name, startedAt: workflowStart }} completed={completedIds} />;
  if (lifecycle?.status !== "running") return <StageActivityPill completed={completedIds} />;

  const latest = latestProgressEvent(events, lifecycle.startedAt);
  const label = lifecycle.reason === "cancelling" ? (zh ? "正在停止…" : "Stopping…")
    : lifecycle.reason === "verifying" ? (zh ? "正在验收" : "Verifying")
    : waitingForDelegates ? (zh ? "等待协作任务" : "Waiting for collaborators")
    : latest?.data.kind === "command" && latest.data.status === "running" ? (zh ? "正在运行命令" : "Running a command")
    : progressLabel(latest, zh);
  return <StageActivityPill activity={{
    id: lifecycle === foreground ? "foreground" : "delegates",
    label,
    startedAt: lifecycle.startedAt ? Date.parse(lifecycle.startedAt) : undefined
  }} completed={completedIds} />;
}

/** Live, provider-neutral progress derived only from persisted runtime events. */
export function RunActivityIndicator({ lifecycle, events, waitingForDelegates = false }: RunActivityIndicatorProps): JSX.Element | null {
  const { locale } = useI18n();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const active = lifecycle?.status === "running" || lifecycle?.status === "waiting_approval";
  const latest = useMemo(
    () => latestProgressEvent(events, lifecycle?.startedAt),
    [events, lifecycle?.startedAt]
  );
  // Only show a separate waiting row when the timeline lacks live progress.
  const visible = active && (waitingForDelegates || lifecycle?.reason === "cancelling" || !latest || !hasVisibleProgress(latest));

  useEffect(() => {
    if (!visible) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.parse(latest?.timestamp ?? "") || Date.now();
    let timer = 0;
    const update = (): void => {
      const elapsed = Math.max(0, Date.now() - startedAt);
      setElapsedSeconds(Math.floor(elapsed / 1000));
      timer = window.setTimeout(update, 1000 - elapsed % 1000);
    };
    update();
    return () => window.clearTimeout(timer);
  }, [visible, latest?.id, latest?.timestamp]);

  // A CLI need not expose reasoning text to show that its turn is in flight.
  // Only suppress this line when a dedicated row is displaying live progress;
  // a completed tool/reasoning row must not hide the next model wait.
  if (!active) return null;
  const working = lifecycle?.status === "running";
  const zh = locale === "zh-CN";
  const label = (lifecycle?.reason === "cancelling"
    ? (zh ? "正在停止…" : "Stopping…")
    : waitingForDelegates
    ? (zh ? "等待协作任务" : "Waiting for collaborators")
    : lifecycle?.status === "waiting_approval"
    ? (zh ? "等待你的批准" : "Waiting for your approval")
    : progressLabel(latest, zh)).replace(/…$/, "");

  return (
    <div role="status" className="conversation-run-wait" hidden={!visible} aria-hidden={!visible || undefined}>
      {working ? <span className="conversation-wait-orbit" aria-hidden /> : <Activity size={14} aria-hidden />}
      <span className="conversation-wait-label">
        {label}
        {working && <span className="conversation-wait-sheen" data-label={label} aria-hidden />}
      </span>
      {elapsedSeconds > 0 && <span className="conversation-wait-time" aria-hidden>
        <span className="conversation-wait-divider">·</span>{formatElapsed(elapsedSeconds, zh)}
      </span>}
    </div>
  );
}

function isProgressEvent(event: TimelineEvent): boolean {
  if (event.data.kind === "activity" && event.data.phase === "completed") return false;
  if (event.data.kind === "message") return event.data.sender === "agent";
  return ["activity", "reasoning", "tool_activity", "command", "verification", "approval"].includes(event.data.kind);
}

function latestProgressEvent(events: TimelineEvent[], startedAt?: string): TimelineEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.data.kind === "tool_group") {
      const nested = latestProgressEvent(event.data.items, startedAt);
      if (nested) return nested;
    } else if (isProgressEvent(event) && (!startedAt || event.timestamp >= startedAt)) return event;
  }
  return undefined;
}

function hasVisibleProgress(event: TimelineEvent): boolean {
  const data = event.data;
  if (data.kind === "reasoning") return Boolean(data.streaming);
  if (data.kind === "tool_activity" || data.kind === "command" || data.kind === "verification") return data.status === "running";
  if (data.kind === "approval") return data.approval.status === "pending";
  return data.kind === "message";
}

function progressLabel(event: TimelineEvent | undefined, zh: boolean): string {
  if (!event) return zh ? "正在思考…" : "Thinking…";
  const data = event.data;
  if (data.kind === "reasoning") return zh ? "正在思考…" : "Thinking…";
  if (data.kind === "tool_activity") {
    return data.status === "running"
      ? (zh ? `正在使用 ${data.toolName}` : `Using ${data.toolName}`)
      : (zh ? "正在思考…" : "Thinking…");
  }
  if (data.kind === "command" || data.kind === "verification") return zh ? "正在思考…" : "Thinking…";
  if (data.kind === "approval") return zh ? "等待你的批准" : "Waiting for your approval";
  if (data.kind === "activity") {
    const labels = zh
      ? { queued: "请求已发送，等待 Agent…", provider_queued: "Agent 正忙，排队中…", starting: "等待 Agent 响应…", thinking: "正在思考…", responding: "正在回复…", completed: "已完成", stopped: "已停止" }
      : { queued: "Request sent · waiting for agent…", provider_queued: "Agent busy · queued…", starting: "Waiting for agent…", thinking: "Thinking…", responding: "Responding…", completed: "Completed", stopped: "Stopped" };
    return labels[data.phase];
  }
  return zh ? "Agent 正在处理…" : "Agent is working…";
}

function formatElapsed(seconds: number, zh: boolean): string {
  if (zh) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const rest = seconds % 60;
    return `${hours ? `${hours}小时` : ""}${minutes ? `${minutes}分` : ""}${rest ? `${rest}秒` : ""}`;
  }
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
