import { useEffect, useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useI18n } from "../../lib/i18n";
import { toolActivityKind } from "../../lib/tool-display";
import { useUiReducedMotion } from "../../lib/ui-motion";
import type { RunLifecycle, TimelineEvent } from "../../lib/types";

export function RunActivityIndicator({ lifecycle, events, runId, waitingForDelegates }: {
  lifecycle?: RunLifecycle;
  events: TimelineEvent[];
  runId?: string;
  waitingForDelegates?: boolean;
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const reducedMotion = useUiReducedMotion();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const working = lifecycle?.status === "running";
  const waiting = lifecycle?.status === "waiting_approval";
  const startedAt = lifecycle?.startedAt;
  const latest = useMemo(() => {
    if (!working && !waiting) return undefined;
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (event.background || (runId ? event.runId !== runId : startedAt && event.timestamp < startedAt)) continue;
      const data = event.data;
      if (data.kind === "message" ? data.sender === "agent"
        : ["activity", "reasoning", "tool_activity", "command", "verification", "approval"].includes(data.kind)) return event;
    }
    return undefined;
  }, [events, working, waiting, runId, startedAt]);
  const label = lifecycle?.reason === "cancelling" ? (zh ? "正在停止" : "Stopping")
    : waiting ? (zh ? "等待你的批准" : "Waiting for your approval")
    : waitingForDelegates ? (zh ? "等待协作任务" : "Waiting for collaborators")
    : lifecycle?.reason === "verifying" ? (zh ? "正在验收" : "Verifying")
    : progressLabel(latest, zh).replace(/…$/, "");

  useEffect(() => {
    if (!working) { setElapsedSeconds(0); return; }
    const start = (latest?.timestamp ? Date.parse(latest.timestamp) : !latest && startedAt ? Date.parse(startedAt) : NaN) || Date.now();
    let timer = 0;
    const tick = (): void => {
      const elapsed = Math.max(0, Date.now() - start);
      setElapsedSeconds(Math.floor(elapsed / 1000));
      timer = window.setTimeout(tick, 1000 - elapsed % 1000);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [working, startedAt, latest?.id, latest?.timestamp]);

  return <AnimatePresence initial={false}>
    {(working || waiting) && <motion.div key="frontier" role="status" className="conversation-run-wait"
      initial={{ opacity: reducedMotion ? 1 : 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}>
      {working ? <span className="conversation-wait-orbit" aria-hidden /> : <Activity size={14} aria-hidden />}
      <span className="conversation-wait-label">{label}</span>
      {working && <span className="conversation-wait-time" aria-hidden>
        <span className="conversation-wait-divider">·</span>{formatElapsed(elapsedSeconds, zh)}
      </span>}
    </motion.div>}
  </AnimatePresence>;
}

function progressLabel(event: TimelineEvent | undefined, zh: boolean): string {
  if (!event) return zh ? "正在思考…" : "Thinking…";
  const data = event.data;
  if (data.kind === "reasoning") return zh ? "正在思考…" : "Thinking…";
  if (data.kind === "tool_activity") {
    if (data.status === "running" && toolActivityKind(data.toolName, data.input) === "command")
      return zh ? "正在运行命令" : "Running a command";
    return data.status === "running"
      ? (zh ? `正在使用 ${data.toolName}` : `Using ${data.toolName}`)
      : (zh ? "正在思考…" : "Thinking…");
  }
  if (data.kind === "command" || data.kind === "verification") {
    return data.status === "running" ? (zh ? "正在运行命令" : "Running a command") : (zh ? "正在思考" : "Thinking");
  }
  if (data.kind === "message") return data.streaming ? (zh ? "正在回复" : "Responding") : (zh ? "正在思考" : "Thinking");
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
    return `${hours ? `${hours}小时` : ""}${minutes ? `${minutes}分` : ""}${rest || (!hours && !minutes) ? `${rest}秒` : ""}`;
  }
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
