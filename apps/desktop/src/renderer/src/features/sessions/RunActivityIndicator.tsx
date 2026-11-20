import { useEffect, useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import type { RunLifecycle, TimelineEvent } from "../../lib/types";

interface RunActivityIndicatorProps {
  lifecycle?: RunLifecycle;
  events: TimelineEvent[];
  waitingForDelegates?: boolean;
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
    const startedAt = latest ? new Date(latest.timestamp).getTime() : Date.now();
    const update = (): void => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [visible, latest?.id, latest?.timestamp]);

  // A CLI need not expose reasoning text to show that its turn is in flight.
  // Only suppress this line when a dedicated row is displaying live progress;
  // a completed tool/reasoning row must not hide the next model wait.
  if (!visible) return null;
  const working = lifecycle?.status === "running";
  const zh = locale === "zh-CN";
  const label = lifecycle?.reason === "cancelling"
    ? (zh ? "正在停止…" : "Stopping…")
    : waitingForDelegates
    ? (zh ? "等待协作任务" : "Waiting for collaborators")
    : lifecycle?.status === "waiting_approval"
    ? (zh ? "等待你的批准" : "Waiting for your approval")
    : progressLabel(latest, zh);

  return (
    <div role="status" className="conversation-run-wait flex items-center py-1 text-[13px] text-ink-3">
      <span className={`conversation-step-icon${working ? " conversation-activity-pulse" : ""}`} aria-hidden>
        {!working && <Activity size={14} />}
      </span>
      <span className="min-w-0 truncate">{label}</span>
      <span aria-hidden="true" className="ml-auto shrink-0 text-xs tabular-nums">{formatElapsed(elapsedSeconds)}</span>
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

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
