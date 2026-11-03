import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
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
    () => [...events].reverse().find((event) =>
      isProgressEvent(event) && (!lifecycle?.startedAt || event.timestamp >= lifecycle.startedAt)
    ),
    [events, lifecycle?.startedAt]
  );

  useEffect(() => {
    if (!active) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = latest ? new Date(latest.timestamp).getTime() : Date.now();
    const update = (): void => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [active, latest?.id, latest?.timestamp]);

  // Reasoning, tool, command, verification, and approval events already have
  // dedicated timeline rows. Rendering this generic indicator as well would
  // show the same in-flight operation twice.
  if (!active || (!waitingForDelegates && latest && latest.data.kind !== "activity")) return null;
  // Nothing to show until the agent is actually thinking — no waiting line.
  if (
    !waitingForDelegates &&
    (!latest || (latest.data.kind === "activity" && (latest.data.phase === "queued" || latest.data.phase === "starting")))
  ) {
    return null;
  }
  const zh = locale === "zh-CN";
  const label = waitingForDelegates
    ? (zh ? "等待协作任务" : "Waiting for collaborators")
    : lifecycle?.status === "waiting_approval"
    ? (zh ? "等待你的批准" : "Waiting for your approval")
    : progressLabel(latest, zh);

  return (
    <div role="status" className="flex items-center gap-2 py-1 text-sm text-ink-3">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
      <span className="ml-auto shrink-0 text-xs tabular-nums">{formatElapsed(elapsedSeconds)}</span>
    </div>
  );
}

function isProgressEvent(event: TimelineEvent): boolean {
  if (event.data.kind === "activity" && event.data.phase === "completed") return false;
  return ["activity", "reasoning", "tool_activity", "command", "verification", "approval"].includes(event.data.kind);
}

function progressLabel(event: TimelineEvent | undefined, zh: boolean): string {
  if (!event) return zh ? "等待 Agent 响应…" : "Waiting for agent…";
  const data = event.data;
  if (data.kind === "reasoning") return zh ? "正在思考，已收到推理摘要" : "Thinking · reasoning summary received";
  if (data.kind === "tool_activity") {
    return data.status === "running"
      ? (zh ? `正在使用 ${data.toolName}` : `Using ${data.toolName}`)
      : (zh ? `${data.toolName} 已完成，继续处理中…` : `${data.toolName} finished · continuing…`);
  }
  if (data.kind === "command") return zh ? "正在执行命令" : "Running command";
  if (data.kind === "verification") return zh ? "正在执行验收" : "Running verification";
  if (data.kind === "approval") return zh ? "等待你的批准" : "Waiting for your approval";
  if (data.kind === "activity") {
    const labels = zh
      ? { queued: "请求已发送，等待 Agent…", starting: "等待 Agent 响应…", thinking: "正在思考…", responding: "正在回复…", completed: "已完成" }
      : { queued: "Request sent · waiting for agent…", starting: "Waiting for agent…", thinking: "Thinking…", responding: "Responding…", completed: "Completed" };
    return labels[data.phase];
  }
  return zh ? "Agent 正在处理…" : "Agent is working…";
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
