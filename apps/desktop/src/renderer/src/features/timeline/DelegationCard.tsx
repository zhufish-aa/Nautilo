import { useId, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, GitBranch, Loader2, AlertTriangle, CircleDashed, X } from "lucide-react";
import type { ChipTone } from "../../components/ui/Badge";
import { IdentityAvatar } from "../../components/ui/IdentityAvatar";
import "./DelegationCard.css";

export function DelegationCard({ name, task, status, tone, running, cancelled, meta, actionLabel, onOpen, input, output, toolName, native, time, zh }: {
  name: string;
  task?: string;
  status: string;
  tone: ChipTone;
  running?: boolean;
  cancelled?: boolean;
  meta?: string[];
  actionLabel?: string;
  onOpen?: () => void;
  input?: string;
  output?: string;
  toolName?: string;
  native?: boolean;
  time?: string;
  zh: boolean;
}): JSX.Element {
  const titleId = useId();
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasDetails = Boolean(input || output);
  const StatusIcon = running ? Loader2 : tone === "ok" ? Check : tone === "danger" || tone === "warn" ? AlertTriangle : cancelled ? X : CircleDashed;
  return <article className="delegation-card" aria-labelledby={titleId}>
    <header className="delegation-card-heading" title={time}>
      <IdentityAvatar label={name} size="sm" />
      <div className="delegation-card-identity">
        <h3 id={titleId}>{name}</h3>
        <span className="delegation-card-kind"><GitBranch size={12} aria-hidden />{native ? (zh ? "原生子 Agent" : "Native subagent") : (zh ? "团队委派" : "Team task")}</span>
      </div>
      <span className="delegation-card-status" data-tone={tone} role="status">
        <StatusIcon size={13} className={running ? "motion-safe:animate-spin" : undefined} aria-hidden />{status}
      </span>
    </header>
    {task && <div className="delegation-card-task">{task}</div>}
    {Boolean(meta?.length) && <div className="delegation-card-meta">{meta?.map((item, index) => <span key={`${index}-${item}`}>{item}</span>)}</div>}
    {Boolean(hasDetails || onOpen) && <footer className="delegation-card-footer">
      {hasDetails && <button type="button" className="delegation-card-details-toggle" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen((open) => !open)}>
        <ChevronDown size={13} aria-hidden />{zh ? "调用详情" : "Call details"}
      </button>}
      {onOpen && <button type="button" className="delegation-card-open" onClick={onOpen}>{actionLabel ?? (zh ? "查看子会话" : "Open session")}<ArrowUpRight size={14} aria-hidden /></button>}
    </footer>}
    {hasDetails && <div id={detailsId} className="delegation-card-details" hidden={!detailsOpen}>
      {detailsOpen && <>
        {toolName && <div className="delegation-card-tool">{toolName}</div>}
        {input && <pre aria-label={zh ? "调用参数" : "Arguments"}>{input}</pre>}
        {output && <pre aria-label={zh ? "调用结果" : "Result"}>{output}</pre>}
      </>}
    </div>}
  </article>;
}
