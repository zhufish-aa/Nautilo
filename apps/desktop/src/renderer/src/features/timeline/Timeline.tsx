import { useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRightLeft,
  BrainCircuit,
  Check,
  ChevronDown,
  ClipboardList,
  FileCode2,
  FlaskConical,
  GitBranch,
  ImageIcon,
  Loader2,
  Sparkles,
  SquareTerminal,
  User,
  Wrench,
  X
} from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { cn, formatDateTime } from "../../lib/utils";
import type { ApprovalScope, TimelineEvent } from "../../lib/types";
import { StatusChip, Tag } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { resolveWorkbenchApproval } from "../../lib/orchestration-runtime";
import { MarkdownContent } from "./MarkdownContent";

function CardShell({
  icon: Icon,
  tone = "accent",
  title,
  time,
  children,
  className
}: {
  icon: typeof GitBranch;
  tone?: "accent" | "ok" | "warn" | "danger" | "info" | "muted";
  title?: React.ReactNode;
  time?: string;
  children?: React.ReactNode;
  className?: string;
}): JSX.Element {
  const toneClasses: Record<string, string> = {
    accent: "border-accent/20 bg-accent-soft text-accent",
    ok: "border-ok/20 bg-ok/10 text-ok",
    warn: "border-warn/20 bg-warn/10 text-warn",
    danger: "border-danger/20 bg-danger/10 text-danger",
    info: "border-info/20 bg-info/10 text-info",
    muted: "border-line bg-card-hover text-ink-3"
  };
  return (
    <motion.article
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 28 }}
      className={cn("flex gap-3", className)}
    >
      <span
        aria-hidden
        className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border", toneClasses[tone])}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        {(title || time) && (
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <div className="min-w-0 text-[13px] font-medium text-ink-2">{title}</div>
            {time && <time className="shrink-0 text-[11px] text-ink-3">{time}</time>}
          </div>
        )}
        {children}
      </div>
    </motion.article>
  );
}

function MessageCard({ event, locale }: { event: TimelineEvent & { data: { kind: "message" } }; locale: "zh-CN" | "en-US" }): JSX.Element {
  const { sender, authorName, text, streaming } = event.data;
  const isUser = sender === "user";
  const isSystem = sender === "system";
  if (isSystem) {
    return (
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="py-1 text-center text-xs text-ink-3"
      >
        — {text} · {formatDateTime(event.timestamp, locale)} —
      </motion.p>
    );
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 28 }}
      className={cn("flex gap-3", isUser && "flex-row-reverse")}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border",
          isUser ? "border-accent/30 bg-gradient-to-br from-accent to-accent-2 text-white" : "border-accent/20 bg-accent-soft text-accent"
        )}
      >
        <User className="h-4 w-4" />
      </span>
      <div className={cn("max-w-[78%] min-w-0", isUser && "flex flex-col items-end")}>
        <div className="mb-1 flex items-baseline gap-2 text-[11px] text-ink-3">
          <span className="font-medium text-ink-2">{isUser ? (locale === "zh-CN" ? "你" : "You") : authorName ?? "Agent"}</span>
          <time>{formatDateTime(event.timestamp, locale)}</time>
        </div>
        <div
          className={cn(
            "rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
            isUser
              ? "rounded-tr-md bg-gradient-to-br from-accent to-accent-2 text-on-accent shadow-[0_4px_16px_-6px_var(--accent)]"
              : "rounded-tl-md border border-line bg-card text-ink"
          )}
        >
          <MarkdownContent source={text} inverted={isUser} />
          {streaming && <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-accent align-text-bottom" aria-label={locale === "zh-CN" ? "正在流式生成" : "Streaming"} />}
        </div>
      </div>
    </motion.div>
  );
}

function ActivityLine({ event, locale }: { event: TimelineEvent & { data: { kind: "activity" } }; locale: "zh-CN" | "en-US" }): JSX.Element {
  const zh = locale === "zh-CN";
  const labels = zh
    ? { queued: "请求已发送", starting: "正在启动 Agent", thinking: "正在思考", responding: "正在整理回复", completed: "本轮已完成" }
    : { queued: "Request sent", starting: "Starting agent", thinking: "Thinking", responding: "Preparing response", completed: "Turn completed" };
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 py-0.5 text-xs text-ink-3">
      {event.data.phase === "completed"
        ? <Sparkles className="h-3.5 w-3.5 text-ok" aria-hidden />
        : <span className="mx-1 h-1.5 w-1.5 rounded-full bg-accent/70" aria-hidden />}
      <span>{labels[event.data.phase]}</span>
      <time className="ml-auto text-[11px]">{formatDateTime(event.timestamp, locale)}</time>
    </motion.div>
  );
}

function ReasoningCard({ event, locale }: { event: TimelineEvent & { data: { kind: "reasoning" } }; locale: "zh-CN" | "en-US" }): JSX.Element {
  const [open, setOpen] = useState(true);
  const zh = locale === "zh-CN";
  return (
    <motion.article initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-line bg-card/70">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[13px] text-ink-2 outline-none transition-colors hover:bg-card-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/45"
      >
        <BrainCircuit className="h-4 w-4 shrink-0 text-accent" aria-hidden />
        <span className="font-medium">
          {event.data.streaming ? (zh ? "推理中" : "Reasoning") : (zh ? "推理完成" : "Reasoning complete")}
        </span>
        {event.data.streaming && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" aria-hidden />}
        <ChevronDown className={cn("ml-auto h-3.5 w-3.5 text-ink-3 transition-transform duration-200", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} className="overflow-hidden">
          <div className="border-t border-line px-3.5 py-3 text-[13px] leading-relaxed text-ink-2">
            <MarkdownContent source={event.data.text} />
            {event.data.streaming && <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-accent align-text-bottom" aria-hidden />}
          </div>
        </motion.div>
      )}
    </motion.article>
  );
}

function ToolActivityCard({ event, locale }: { event: TimelineEvent & { data: { kind: "tool_activity" } }; locale: "zh-CN" | "en-US" }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { toolName, status, input, output } = event.data;
  const details = Boolean(input || output);
  const zh = locale === "zh-CN";
  return (
    <motion.article initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2.5 text-[13px]">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-info/10 text-info">
        {status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Wrench className="h-3.5 w-3.5" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          disabled={!details}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center gap-2 py-1 text-left text-ink-2 disabled:cursor-default"
        >
          <span className="truncate font-medium">{status === "running" ? (zh ? "正在使用" : "Using") : (zh ? "已使用" : "Used")} {toolName}</span>
          {details && <ChevronDown className={cn("ml-auto h-3.5 w-3.5 text-ink-3 transition-transform", open && "rotate-180")} aria-hidden />}
        </button>
        {details && open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} className="mt-1 overflow-hidden rounded-lg border border-line bg-card-hover">
            {input && (
              <div className="px-3 py-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">{zh ? "输入" : "Input"}</div>
                <pre className="max-h-40 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">{input}</pre>
              </div>
            )}
            {output && (
              <div className={cn("px-3 py-2", input && "border-t border-line")}>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">{zh ? "结果" : "Result"}</div>
                <pre className="max-h-56 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">{output}</pre>
              </div>
            )}
          </motion.div>
        )}
      </div>
    </motion.article>
  );
}

function UsageLine({ event, locale }: { event: TimelineEvent & { data: { kind: "usage" } }; locale: "zh-CN" | "en-US" }): JSX.Element {
  const zh = locale === "zh-CN";
  return (
    <p className="text-right font-mono text-[11px] text-ink-3">
      {zh ? "Token" : "Tokens"}: {event.data.inputTokens ?? 0} in / {event.data.outputTokens ?? 0} out
    </p>
  );
}

function ArtifactCard({ event, locale }: { event: TimelineEvent & { data: { kind: "artifact" } }; locale: "zh-CN" | "en-US" }): JSX.Element {
  const { artifactType, name, mimeType, content, path } = event.data;
  const source = artifactType === "image"
    ? content?.startsWith("data:")
      ? content
      : content
        ? `data:${mimeType ?? "image/png"};base64,${content}`
        : path
          ? `agenthub-artifact://local/?path=${encodeURIComponent(path)}`
          : undefined
    : undefined;
  return (
    <CardShell
      icon={ImageIcon}
      tone="info"
      title={artifactType === "image" ? (locale === "zh-CN" ? "生成的图片" : "Generated image") : name}
      time={formatDateTime(event.timestamp, locale)}
    >
      {source ? (
        <figure className="overflow-hidden rounded-xl border border-line bg-card">
          <img src={source} alt={name} className="max-h-[520px] w-full object-contain" />
          <figcaption className="border-t border-line px-3 py-2 text-xs text-ink-3">{name}</figcaption>
        </figure>
      ) : (
        <p className="rounded-xl border border-line bg-card px-3 py-2 font-mono text-xs text-ink-2">{path ?? name}</p>
      )}
    </CardShell>
  );
}

function PlannerDecisionCard({ event, t, locale }: { event: TimelineEvent & { data: { kind: "planner_decision" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string }): JSX.Element {
  const modeTone = { direct: "ok", delegate: "info", plan: "accent" } as const;
  return (
    <CardShell
      icon={GitBranch}
      tone={modeTone[event.data.mode]}
      title={<StatusChip tone={modeTone[event.data.mode]} label={t(`sessions.cards.decision.${event.data.mode}` as MessageKey)} />}
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <p className="rounded-xl border border-line bg-card px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-2">
        {event.data.rationale}
      </p>
    </CardShell>
  );
}

function RecoveryDecisionCard({ event, locale }: { event: TimelineEvent & { data: { kind: "recovery_decision" } }; locale: string }): JSX.Element {
  return (
    <CardShell
      icon={GitBranch}
      tone={event.data.action === "retry" ? "info" : event.data.action === "take_over" ? "accent" : "warn"}
      title={`Failure recovery · ${event.data.action}`}
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <p className="rounded-xl border border-line bg-card px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-2">
        {event.data.rationale}
      </p>
    </CardShell>
  );
}

function TaskUpdateCard({ event, t, locale, onOpenSession }: { event: TimelineEvent & { data: { kind: "task_update" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string; onOpenSession?: (id: string) => void }): JSX.Element {
  const statusTone: Record<string, "muted" | "info" | "accent" | "ok" | "danger" | "warn"> = {
    queued: "muted",
    running: "accent",
    completed: "ok",
    failed: "danger",
    cancelled: "muted",
    blocked_dependency: "warn",
    verifying: "info"
  };
  return (
    <CardShell
      icon={ClipboardList}
      tone={statusTone[event.data.status] ?? "muted"}
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="truncate">{event.data.memberName ? (locale === "zh-CN" ? `已委派给 ${event.data.memberName}` : `Delegated to ${event.data.memberName}`) : event.data.title}</span>
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card px-3.5 py-2.5">
        <span className="min-w-0 truncate text-[13px] text-ink-2">{event.data.title}</span>
        <span className="inline-flex shrink-0 items-center gap-2">
          <StatusChip
            tone={statusTone[event.data.status] ?? "muted"}
            label={t(`sessions.taskStatus.${event.data.status}` as MessageKey)}
            pulse={event.data.status === "running"}
          />
          {event.data.sessionId && onOpenSession && (
            <button
              type="button"
              onClick={() => onOpenSession(event.data.sessionId!)}
              className="rounded-md px-1.5 py-0.5 text-xs font-medium text-accent transition-colors hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
            >
              {t("sessions.cards.openSub")}
            </button>
          )}
        </span>
      </div>
    </CardShell>
  );
}

function commandPresentation(command: string): { summary: string; full: string } {
  const full = command.replaceAll("\\\\", "\\").replace(/\s+/g, " ").trim();
  const executableMatch = full.match(/^"([^"]+)"|^(\S+)/);
  const executable = (executableMatch?.[1] ?? executableMatch?.[2] ?? "command").split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "") ?? "command";
  const commandBody = full.match(/(?:^|\s)-(?:Command|c)\s+(.+)$/i)?.[1]?.replace(/^"|"$/g, "")
    ?? full.slice(executableMatch?.[0].length ?? 0).trim();
  const targetPath = commandBody.match(/-(?:LiteralPath|Path)\s+['"]([^'"]+)['"]/i)?.[1];
  const operation = commandBody.match(/^([\w-]+)/)?.[1];
  const targetName = targetPath?.split(/[\\/]/).at(-1);
  const label = targetName
    ? [executable, operation, targetName].filter(Boolean).join(" · ")
    : commandBody ? `${executable} · ${commandBody}` : executable;
  return { full, summary: label.length > 96 ? `${label.slice(0, 93)}…` : label };
}

function CommandCard({ event, t, locale }: { event: TimelineEvent & { data: { kind: "command" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string }): JSX.Element {
  // F-028: commands default to collapsed, expand to see output.
  const [open, setOpen] = useState(false);
  const { command, status, exitCode, output, attempts = 1 } = event.data;
  const presented = commandPresentation(command);
  const zh = locale === "zh-CN";
  return (
    <CardShell
      icon={SquareTerminal}
      tone={status === "failed" ? "danger" : status === "running" ? "accent" : "muted"}
      title={
        <span className="flex w-full min-w-0 items-center gap-2 overflow-hidden">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2" title={presented.full}>{presented.summary}</code>
          {attempts > 1 && <Tag label={zh ? `${attempts} 次尝试` : `${attempts} attempts`} className="h-5 shrink-0" />}
          {status === "running" ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" aria-label={t("sessions.cards.running")} />
          ) : (
            exitCode !== undefined && (
              <StatusChip
                tone={exitCode === 0 ? "ok" : "danger"}
                label={t("sessions.cards.exitCode", { code: exitCode })}
              />
            )
          )}
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      {(command || output) && (
        <div className="rounded-xl border border-line bg-card">
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
            className="flex w-full items-center justify-between gap-2 px-3.5 py-2 text-xs text-ink-3 transition-colors hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
          >
            <span>{zh ? "详情" : "Details"}</span>
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", open && "rotate-180")} aria-hidden />
          </button>
          {open && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} className="max-h-72 overflow-auto border-t border-line">
              <div className="px-3.5 py-2.5">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">{zh ? "命令" : "Command"}</div>
                <pre className="overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-ink-2">{presented.full}</pre>
              </div>
              {output && (
                <div className="border-t border-line px-3.5 py-2.5">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">{t("sessions.cards.output")}</div>
                  <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-ink-2">{output}</pre>
                </div>
              )}
            </motion.div>
          )}
        </div>
      )}
    </CardShell>
  );
}

function FileChangeCard({
  event,
  t,
  locale,
  onViewDiff
}: {
  event: TimelineEvent & { data: { kind: "file_change" } };
  t: (k: MessageKey, v?: Record<string, string | number>) => string;
  locale: string;
  onViewDiff?: () => void;
}): JSX.Element {
  const { files } = event.data;
  return (
    <CardShell
      icon={FileCode2}
      tone="info"
      title={
        <span className="inline-flex items-center gap-2">
          {t("sessions.cards.files", { count: files.length })}
          {onViewDiff && (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onViewDiff}>
              {t("sessions.cards.viewDiff")}
            </Button>
          )}
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <ul className="overflow-hidden rounded-xl border border-line bg-card">
        {files.map((file) => (
          <li key={file.path} className="flex items-center gap-2.5 border-b border-line px-3.5 py-2 last:border-0">
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full shrink-0",
                file.changeType === "added" ? "bg-ok" : file.changeType === "deleted" ? "bg-danger" : "bg-info"
              )}
              aria-label={file.changeType}
            />
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2" title={file.path}>
              {file.path}
            </code>
            <span className="shrink-0 font-mono text-[11px]">
              <span className="text-ok">+{file.additions}</span>{" "}
              <span className="text-danger">-{file.deletions}</span>
            </span>
          </li>
        ))}
      </ul>
    </CardShell>
  );
}

function VerificationCard({ event, t, locale }: { event: TimelineEvent & { data: { kind: "verification" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { command, status, durationMs, log } = event.data;
  return (
    <CardShell
      icon={FlaskConical}
      tone={status === "failed" ? "danger" : status === "passed" ? "ok" : "accent"}
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="shrink-0">{t("sessions.cards.verification")}</span>
          <code className="truncate font-mono text-xs text-ink-3">{command}</code>
          {status === "running" ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" aria-label={t("sessions.cards.running")} />
          ) : (
            <StatusChip tone={status === "passed" ? "ok" : "danger"} label={t(status === "passed" ? "sessions.cards.passed" : "sessions.cards.failed")} />
          )}
          {durationMs !== undefined && status !== "running" && (
            <span className="shrink-0 font-mono text-[11px] text-ink-3">
              {t("sessions.cards.duration", { seconds: (durationMs / 1000).toFixed(1) })}
            </span>
          )}
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      {log && (
        <div className="rounded-xl border border-line bg-card">
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
            className="flex w-full items-center justify-between gap-2 px-3.5 py-2 text-xs text-ink-3 transition-colors hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
          >
            <span>{t("sessions.cards.log")}</span>
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", open && "rotate-180")} aria-hidden />
          </button>
          {open && (
            <pre className="max-h-56 overflow-auto border-t border-line px-3.5 py-2.5 font-mono text-xs leading-relaxed text-ink-2">
              {log}
            </pre>
          )}
        </div>
      )}
    </CardShell>
  );
}

function GitMergeCard({ event, locale }: { event: TimelineEvent & { data: { kind: "git_merge" } }; locale: string }): JSX.Element {
  const { status, sourceBranch, targetBranch, commit, paths } = event.data;
  const zh = locale === "zh-CN";
  const labels = {
    running: zh ? "合并中" : "Merging",
    completed: zh ? "已合并" : "Merged",
    conflict: zh ? "存在冲突" : "Conflict"
  } as const;
  return (
    <CardShell
      icon={GitBranch}
      tone={status === "conflict" ? "danger" : status === "completed" ? "ok" : "accent"}
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span>{zh ? "Git 合并" : "Git merge"}</span>
          <StatusChip tone={status === "conflict" ? "danger" : status === "completed" ? "ok" : "accent"} label={labels[status]} pulse={status === "running"} />
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <div className="space-y-2 rounded-xl border border-line bg-card px-3.5 py-2.5 text-[13px] text-ink-2">
        <p className="font-mono break-all">{sourceBranch} → {targetBranch}</p>
        {commit && <p className="font-mono text-xs text-ink-3">commit {commit}</p>}
        {paths && paths.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-danger">{zh ? "冲突文件" : "Conflicted files"}</p>
            <ul className="space-y-1 font-mono text-xs text-danger">
              {paths.map((path) => <li key={path}>{path}</li>)}
            </ul>
          </div>
        )}
      </div>
    </CardShell>
  );
}

const SCOPES: ApprovalScope[] = ["once", "run", "task", "project", "global"];

function ApprovalCard({ event, t, locale }: { event: TimelineEvent & { data: { kind: "approval" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string }): JSX.Element {
  const { approval } = event.data;
  const [scope, setScope] = useState<ApprovalScope>(approval.kind === "merge" ? "project" : approval.kind === "delegate" ? "run" : "once");
  const pending = approval.status === "pending";
  return (
    <CardShell
      icon={AlertTriangle}
      tone="warn"
      title={
        <span className="inline-flex items-center gap-2">
          {t("sessions.cards.approval")}
          <StatusChip
            tone={pending ? "warn" : approval.status === "approved" ? "ok" : "danger"}
            label={t(pending ? "sessions.status.waiting_approval" : approval.status === "approved" ? "sessions.cards.approved" : "sessions.cards.rejected")}
            pulse={pending}
          />
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <div className="rounded-xl border border-warn/25 bg-warn/5 px-4 py-3">
        <p className="text-sm font-medium text-ink">{approval.title}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{approval.description}</p>
        {pending && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-line bg-card p-0.5" role="radiogroup" aria-label={t("sessions.cards.scope")}>
              {SCOPES.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={scope === item}
                  onClick={() => setScope(item)}
                  className={cn(
                    "h-7 rounded-md px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                    scope === item ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink-2"
                  )}
                >
                  {t(`sessions.cards.scope${item[0].toUpperCase()}${item.slice(1)}` as MessageKey)}
                </button>
              ))}
            </div>
            <Button variant="primary" size="sm" onClick={() => void resolveWorkbenchApproval(event.sessionId, approval.id, true, scope)}>
              <Check className="h-3.5 w-3.5" aria-hidden />
              {t("sessions.cards.approve")}
            </Button>
            <Button variant="danger" size="sm" onClick={() => void resolveWorkbenchApproval(event.sessionId, approval.id, false, scope)}>
              <X className="h-3.5 w-3.5" aria-hidden />
              {t("sessions.cards.reject")}
            </Button>
          </div>
        )}
      </div>
    </CardShell>
  );
}

function ErrorCard({ event, t, locale }: { event: TimelineEvent & { data: { kind: "error" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string }): JSX.Element {
  return (
    <CardShell
      icon={AlertTriangle}
      tone="danger"
      title={
        <span className="inline-flex items-center gap-2">
          {t("sessions.cards.error")}
          <code className="rounded bg-danger/10 px-1.5 py-0.5 font-mono text-[11px] text-danger">{event.data.code}</code>
          <StatusChip tone={event.data.retryable ? "info" : "muted"} label={t(event.data.retryable ? "sessions.cards.retryable" : "sessions.cards.notRetryable")} />
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <p className="rounded-xl border border-danger/25 bg-danger/5 px-3.5 py-2.5 text-[13px] text-ink-2">
        {event.data.message}
      </p>
    </CardShell>
  );
}

function HandoffCard({ event, t, locale, onOpenSession }: { event: TimelineEvent & { data: { kind: "handoff" } }; t: (k: MessageKey, v?: Record<string, string | number>) => string; locale: string; onOpenSession?: (id: string) => void }): JSX.Element {
  return (
    <CardShell
      icon={ArrowRightLeft}
      tone="info"
      title={
        <span className="inline-flex min-w-0 items-center gap-2 text-[13px]">
          <span className="shrink-0 text-ink-3">{t("sessions.cards.handoff")}</span>
          <Tag label={event.data.fromName} />
          <span aria-hidden className="text-ink-3">→</span>
          <Tag label={event.data.toName} />
          {event.data.sessionId && onOpenSession && (
            <button
              type="button"
              onClick={() => onOpenSession(event.data.sessionId!)}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium text-accent transition-colors hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
            >
              {t("sessions.cards.openSub")} →
            </button>
          )}
        </span>
      }
      time={formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}
    >
      <p className="rounded-xl border border-line bg-card px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-2">
        {event.data.summary}
      </p>
    </CardShell>
  );
}

export function TimelineEventView({
  event,
  onViewDiff,
  onOpenSession
}: {
  event: TimelineEvent;
  onViewDiff?: () => void;
  onOpenSession?: (id: string) => void;
}): JSX.Element | null {
  const { t, locale } = useI18n();
  const data = event.data;

  switch (data.kind) {
    case "message":
      return <MessageCard event={event as TimelineEvent & { data: { kind: "message" } }} locale={locale} />;
    case "activity":
      return <ActivityLine event={event as TimelineEvent & { data: { kind: "activity" } }} locale={locale} />;
    case "reasoning":
      return <ReasoningCard event={event as TimelineEvent & { data: { kind: "reasoning" } }} locale={locale} />;
    case "tool_activity":
      return <ToolActivityCard event={event as TimelineEvent & { data: { kind: "tool_activity" } }} locale={locale} />;
    case "usage":
      return <UsageLine event={event as TimelineEvent & { data: { kind: "usage" } }} locale={locale} />;
    case "artifact":
      return <ArtifactCard event={event as TimelineEvent & { data: { kind: "artifact" } }} locale={locale} />;
    case "planner_decision":
      return <PlannerDecisionCard event={event as TimelineEvent & { data: { kind: "planner_decision" } }} t={t} locale={locale} />;
    case "recovery_decision":
      return <RecoveryDecisionCard event={event as TimelineEvent & { data: { kind: "recovery_decision" } }} locale={locale} />;
    case "task_update":
      return <TaskUpdateCard event={event as TimelineEvent & { data: { kind: "task_update" } }} t={t} locale={locale} onOpenSession={onOpenSession} />;
    case "command":
      return <CommandCard event={event as TimelineEvent & { data: { kind: "command" } }} t={t} locale={locale} />;
    case "file_change":
      return <FileChangeCard event={event as TimelineEvent & { data: { kind: "file_change" } }} t={t} locale={locale} onViewDiff={onViewDiff} />;
    case "verification":
      return <VerificationCard event={event as TimelineEvent & { data: { kind: "verification" } }} t={t} locale={locale} />;
    case "git_merge":
      return <GitMergeCard event={event as TimelineEvent & { data: { kind: "git_merge" } }} locale={locale} />;
    case "approval":
      return <ApprovalCard event={event as TimelineEvent & { data: { kind: "approval" } }} t={t} locale={locale} />;
    case "error":
      return <ErrorCard event={event as TimelineEvent & { data: { kind: "error" } }} t={t} locale={locale} />;
    case "handoff":
      return <HandoffCard event={event as TimelineEvent & { data: { kind: "handoff" } }} t={t} locale={locale} onOpenSession={onOpenSession} />;
    case "run_status":
      return (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-0.5 text-center text-xs text-ink-3">
          — {t(`sessions.status.${data.run.status === "waiting_approval" ? "waiting_approval" : data.run.status}` as MessageKey)}
          {data.run.reason ? ` · ${data.run.reason}` : ""} · {formatDateTime(event.timestamp, locale)} —
        </motion.p>
      );
    case "approval_resolved":
      return (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-0.5 text-center text-xs text-ink-3">
          — {t(data.decision === "approved" ? "sessions.cards.approved" : "sessions.cards.rejected")} · {formatDateTime(event.timestamp, locale)} —
        </motion.p>
      );
    default:
      return null;
  }
}
