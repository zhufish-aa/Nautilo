import { useRef, useState } from "react";
import { Check, Loader2, ShieldCheck, ShieldX } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { SelectField } from "../../components/ui/Select";
import { useI18n, type MessageKey } from "../../lib/i18n";
import type { ApprovalRequest, ApprovalScope } from "../../lib/types";
import "./ManagedApprovalCard.css";

const SCOPES: ApprovalScope[] = ["once", "run", "task", "project", "global"];

export function ManagedApprovalCard({ approval, onResolve }: {
  approval: ApprovalRequest;
  onResolve: (approved: boolean, scope: ApprovalScope) => Promise<void>;
}): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const [scope, setScope] = useState<ApprovalScope>(approval.decisionScope ?? (approval.kind === "merge" ? "project" : approval.kind === "delegate" ? "run" : "once"));
  const [submitting, setSubmitting] = useState<"approve" | "reject">();
  const [error, setError] = useState<string>();
  const locked = useRef(false);
  const pending = approval.status === "pending";
  const launch = approval.kind === "command" ? /^Launch\s+(.+)$/i.exec(approval.description.trim()) : null;
  const title = launch ? `${zh ? "启动" : "Launch"} ${launch[1]}` : approval.kind === "command" ? approval.description || approval.title : approval.title;
  const detail = approval.kind === "command" || approval.description === title ? undefined : approval.description;
  const scopeLabel = (value: ApprovalScope): string => value === "run" && approval.runScope === "session"
    ? zh ? "此会话" : "This session"
    : t(`sessions.cards.scope${value[0].toUpperCase()}${value.slice(1)}` as MessageKey);
  const scopes = approval.availableScopes ?? SCOPES;
  const selectedScope = scopes.includes(scope) ? scope : scopes[0];

  const resolve = async (approved: boolean): Promise<void> => {
    if (locked.current || !pending) return;
    locked.current = true;
    setSubmitting(approved ? "approve" : "reject");
    setError(undefined);
    try {
      await onResolve(approved, selectedScope);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      locked.current = false;
      setSubmitting(undefined);
    }
  };

  return (
    <section className="managed-approval" data-status={approval.status} aria-label={t("sessions.cards.approval")} aria-busy={Boolean(submitting)}>
      <div className="managed-approval-main">
        <span className="managed-approval-icon" aria-hidden>
          {approval.status === "rejected" ? <ShieldX size={18} /> : <ShieldCheck size={18} />}
        </span>
        <div className="managed-approval-identity">
          <h3>{title}</h3>
          <span className="managed-approval-status" role="status">
            {pending ? zh ? "待批准" : "Needs approval" : t(approval.status === "approved" ? "sessions.cards.approved" : "sessions.cards.rejected")}
            {!pending && approval.status === "approved" && approval.decisionScope && <span> · {scopeLabel(approval.decisionScope)}</span>}
          </span>
        </div>
        {pending && <div className="managed-approval-actions">
          <SelectField
            value={selectedScope}
            onValueChange={(value) => setScope(value as ApprovalScope)}
            options={scopes.map((value) => ({ value, label: scopeLabel(value) }))}
            disabled={Boolean(submitting)}
            aria-label={t("sessions.cards.scope")}
            className="managed-approval-scope"
          />
          <Button variant="outline" size="sm" disabled={Boolean(submitting)} onClick={() => void resolve(false)}>
            {submitting === "reject" && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {t("sessions.cards.reject")}
          </Button>
          <Button variant="primary" size="sm" disabled={Boolean(submitting)} onClick={() => void resolve(true)}>
            {submitting === "approve" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Check size={14} aria-hidden />}
            {t("sessions.cards.approve")}
          </Button>
        </div>}
      </div>
      {detail && <p className="managed-approval-detail">{detail}</p>}
      {error && <p className="managed-approval-error" role="alert">{error}</p>}
    </section>
  );
}
