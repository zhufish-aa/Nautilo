import { useMemo, useState, type MouseEvent } from "react";
import { Check, ChevronDown, ClipboardList, Copy, CornerUpLeft, Sparkles, Workflow } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { useUiReducedMotion } from "../../lib/ui-motion";
import type { SessionTask } from "../../lib/types";
import "./delegated-task-card.css";

interface ParsedTaskBrief {
  context?: string;
  approvedTask?: string;
  plain?: string;
}

const APPROVED_SPLIT = /\r?\n\s*Task approved for this workflow run:\s*\r?\n/i;

function parseTaskBrief(raw: string): ParsedTaskBrief {
  const trimmed = raw.trim();
  const match = APPROVED_SPLIT.exec(trimmed);
  if (!match || match.index === undefined) return { plain: trimmed };
  const before = trimmed.slice(0, match.index).trim();
  const after = trimmed.slice(match.index + match[0].length).trim();
  if (!after) return { plain: trimmed };
  return { context: before || undefined, approvedTask: after };
}

export function DelegatedTaskCard({
  description,
  status,
  workflowName,
  nodeName,
  role,
  attempt,
  onOpenParent
}: {
  description: string;
  status?: SessionTask["status"];
  workflowName?: string;
  nodeName?: string;
  role?: string;
  attempt?: number;
  onOpenParent?: () => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const reducedMotion = useUiReducedMotion();
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => parseTaskBrief(description), [description]);
  const isLong = description.length > 340 || description.split(/\r?\n/).length > 6;
  const [expanded, setExpanded] = useState(!isLong);

  const tone = status === "failed"
    ? "danger"
    : status === "completed"
      ? "ok"
      : status === "running" || status === "verifying"
        ? "running"
        : status === "waiting_approval" || status === "waiting_user" || status === "blocked_dependency"
          ? "warn"
          : "muted";

  const isWorkflow = Boolean(workflowName || parsed.approvedTask);

  const handleCopy = (): void => {
    void navigator.clipboard?.writeText(description).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };

  const handlePointerMove = (event: MouseEvent<HTMLElement>): void => {
    if (reducedMotion) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty("--my", `${event.clientY - rect.top}px`);
  };

  return (
    <article
      className="delegated-task-card"
      data-tone={tone}
      data-running={tone === "running" || undefined}
      data-reduced={reducedMotion || undefined}
      onMouseMove={handlePointerMove}
    >
      <header className="delegated-task-header">
        <div className="delegated-task-eyebrow">
          <span className="delegated-task-icon" aria-hidden>
            {isWorkflow ? <Workflow size={13} strokeWidth={1.9} /> : <ClipboardList size={13} strokeWidth={1.9} />}
          </span>
          <h2 className="delegated-task-label">
            {t("sessions.taskContext.details")}
          </h2>
          {workflowName && (
            <>
              <span className="delegated-task-sep" aria-hidden>·</span>
              <span className="delegated-task-crumb" title={workflowName}>{workflowName}</span>
            </>
          )}
          {nodeName && (
            <>
              <span className="delegated-task-sep" aria-hidden>/</span>
              <span className="delegated-task-node">{nodeName}</span>
            </>
          )}
          {role && <span className="delegated-task-role">{role}</span>}
          {attempt !== undefined && attempt > 1 && (
            <span className="delegated-task-attempt">#{attempt}</span>
          )}
        </div>

        <div className="delegated-task-actions">
          {status && (
            <span className="delegated-task-status" data-tone={tone} role="status">
              <span className="delegated-task-dot" aria-hidden />
              <span>{t(`sessions.taskStatus.${status}` as MessageKey)}</span>
            </span>
          )}
          {onOpenParent && (
            <button
              type="button"
              className="delegated-task-icon-btn"
              title={zh ? "返回主会话" : "Back to main conversation"}
              aria-label={zh ? "返回主会话" : "Back to main conversation"}
              onClick={onOpenParent}
            >
              <CornerUpLeft size={13} aria-hidden />
            </button>
          )}
          <button
            type="button"
            className="delegated-task-icon-btn"
            data-copied={copied || undefined}
            title={copied ? (zh ? "已复制" : "Copied") : (zh ? "复制任务说明" : "Copy instructions")}
            aria-label={copied ? (zh ? "已复制" : "Copied") : (zh ? "复制任务说明" : "Copy instructions")}
            onClick={handleCopy}
          >
            {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          </button>
          {isLong && (
            <button
              type="button"
              className="delegated-task-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded(value => !value)}
            >
              <span>{expanded ? (zh ? "收起" : "Collapse") : (zh ? "展开" : "Expand")}</span>
              <ChevronDown size={13} className="delegated-task-caret" aria-hidden />
            </button>
          )}
        </div>
      </header>

      <div className="delegated-task-body" data-clamped={!expanded || undefined}>
        {parsed.approvedTask ? (
          <div className="delegated-task-sections">
            <div className="delegated-task-primary">
              <span className="delegated-task-section-tag">
                <Sparkles size={11} aria-hidden />
                <span>{zh ? "当前节点指令" : "Assigned instruction"}</span>
              </span>
              <p className="delegated-task-text">{parsed.approvedTask}</p>
            </div>

            {parsed.context && (
              <div className="delegated-task-context">
                <span className="delegated-task-section-tag is-muted">
                  {zh ? "任务背景" : "Workflow objective"}
                </span>
                <p className="delegated-task-text is-secondary">{parsed.context}</p>
              </div>
            )}
          </div>
        ) : (
          <p className="delegated-task-text">{parsed.plain}</p>
        )}
      </div>
    </article>
  );
}
