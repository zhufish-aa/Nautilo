import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { BrainCircuit, Sparkles } from "lucide-react";
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
    ? (zh ? "子 Agent 正在运行，完成后会通知主 Agent" : "Child agents are running; the main agent will be notified when they finish")
    : lifecycle?.status === "waiting_approval"
    ? (zh ? "等待你的批准" : "Waiting for your approval")
    : progressLabel(latest, zh);

  const thinking = latest?.data.kind === "reasoning" || (latest?.data.kind === "activity" && latest.data.phase === "thinking");

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.97, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
      transition={{ type: "spring", stiffness: 300, damping: 26 }}
      className="run-indicator run-border relative mt-4 overflow-hidden rounded-2xl border border-accent/25 bg-card/80 shadow-[0_14px_44px_-16px_var(--accent)] backdrop-blur-md"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3.5 px-4 py-3">
        <span className="relative flex h-10 w-10 shrink-0 items-center justify-center" aria-hidden>
          <span className="run-orb-glow absolute inset-0 rounded-full bg-accent/30 blur-md" />
          <span className="run-orb absolute inset-1 rounded-full opacity-90" />
          <span className="run-indicator-icon relative flex h-[26px] w-[26px] items-center justify-center rounded-full bg-card text-accent shadow-inner">
            {thinking ? <BrainCircuit className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="shimmer-text truncate text-[13px] font-medium">{label}</p>
          <p className="run-sublabel mt-0.5 text-[10px] font-medium uppercase tracking-[0.22em] text-ink-3">
            {zh ? "实时运行" : "Live run"}
          </p>
        </div>
        <span className="run-elapsed flex shrink-0 items-center gap-1.5 rounded-full border border-accent/25 bg-accent-soft px-2.5 py-1 font-mono text-[11px] tabular-nums text-accent">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-70 motion-safe:animate-[pulse-ring_1.6s_ease-out_infinite]" aria-hidden />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          </span>
          {formatElapsed(elapsedSeconds)}
        </span>
      </div>
    </motion.div>
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
