import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Check, ChevronDown, ChevronUp, ClipboardCheck, HelpCircle, RotateCcw, Send, ShieldAlert, X, type LucideIcon } from "lucide-react";
import type { InteractionOption, InteractionQuestion, InteractionRequest } from "@agenthub/domain";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { cn, formatDateTime } from "../../lib/utils";
import { useInteractionsStore } from "../../stores/interactions";
import { toast } from "../../stores/toast";
import { StatusChip, type ChipTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { MarkdownContent } from "../timeline/MarkdownContent";

const EMPTY: InteractionRequest[] = [];

/** Known approval option ids get localized labels; anything else keeps the provider label. */
const APPROVAL_OPTION_KEYS: Record<string, MessageKey> = {
  accept: "sessions.interactions.option.accept",
  acceptForSession: "sessions.interactions.option.acceptForSession",
  decline: "sessions.interactions.option.decline",
  cancel: "sessions.interactions.option.cancel",
  allow: "sessions.interactions.option.allow",
  deny: "sessions.interactions.option.deny"
};

function isDangerOption(option: InteractionOption): boolean {
  if (["decline", "deny", "cancel", "reject"].includes(option.id)) return true;
  // Kimi options carry their kind (e.g. allow_once / reject_once) in the description.
  return /reject|deny|decline/i.test(option.description ?? "");
}

/**
 * Pending provider questions/approvals for a session, rendered at the end of
 * the chat timeline. Pending cards are interactive; resolved/cancelled
 * questions stay as a read-only record, while approvals disappear once answered.
 */
export function InteractionCards({ sessionId }: { sessionId: string }): JSX.Element | null {
  const interactions = useInteractionsStore((state) => state.bySession[sessionId] ?? EMPTY);
  const loadPending = useInteractionsStore((state) => state.loadPending);

  useEffect(() => {
    void loadPending(sessionId);
  }, [sessionId, loadPending]);

  const visible = interactions.filter((interaction) => interaction.kind === "question" || interaction.status === "pending");
  if (visible.length === 0) return null;
  return (
    <>
      {visible.map((interaction) =>
        interaction.kind === "question"
          ? <QuestionCard key={interaction.id} interaction={interaction} />
          : interaction.kind === "plan_approval"
            ? <PlanApprovalCard key={interaction.id} interaction={interaction} />
            : <ApprovalCard key={interaction.id} interaction={interaction} />
      )}
    </>
  );
}

function CardShell({
  icon: Icon,
  tone,
  title,
  time,
  children
}: {
  icon: LucideIcon;
  tone: "warn" | "ok" | "muted" | "plan";
  title: React.ReactNode;
  time?: string;
  children: React.ReactNode;
}): JSX.Element {
  const toneClasses = {
    warn: "border-warn/20 bg-warn/10 text-warn",
    ok: "border-ok/20 bg-ok/10 text-ok",
    muted: "border-line bg-card-hover text-ink-3",
    plan: "border-accent/30 bg-accent-soft text-accent"
  } as const;
  return (
    <motion.article
      initial={{ opacity: 0, y: 14, scale: 0.985, filter: "blur(5px)" }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
      transition={{ type: "spring", stiffness: 320, damping: 28 }}
      className="flex gap-3"
    >
      <span aria-hidden className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border", toneClasses[tone])}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <div className="min-w-0 text-[13px] font-medium text-ink-2">{title}</div>
          {time && <time className="shrink-0 text-[11px] text-ink-3">{time}</time>}
        </div>
        {children}
      </div>
    </motion.article>
  );
}

function useInteractionShell(interaction: InteractionRequest): {
  tone: "warn" | "ok" | "muted";
  chipTone: ChipTone;
  chipLabel: string;
  time: string;
} {
  const { t, locale } = useI18n();
  const pending = interaction.status === "pending";
  return {
    tone: pending ? "warn" : interaction.status === "resolved" ? "ok" : "muted",
    chipTone: pending ? "warn" : interaction.status === "resolved" ? "ok" : "muted",
    chipLabel: t(pending
      ? "sessions.interactions.pending"
      : interaction.status === "resolved"
        ? "sessions.interactions.answered"
        : "sessions.interactions.cancelled"),
    time: formatDateTime(interaction.createdAt, locale)
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function QuestionCard({ interaction }: { interaction: InteractionRequest }): JSX.Element {
  const { t } = useI18n();
  const respond = useInteractionsStore((state) => state.respond);
  const shell = useInteractionShell(interaction);
  const questions = interaction.questions ?? [];
  const pending = interaction.status === "pending";

  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const toggleOption = (question: InteractionQuestion, option: InteractionOption): void => {
    setSelections((current) => {
      const selected = current[question.id] ?? [];
      if (question.multiSelect) {
        return {
          ...current,
          [question.id]: selected.includes(option.label)
            ? selected.filter((label) => label !== option.label)
            : [...selected, option.label]
        };
      }
      return { ...current, [question.id]: [option.label] };
    });
    // Single choice and the free-text escape hatch are mutually exclusive.
    if (!question.multiSelect) setTexts((current) => ({ ...current, [question.id]: "" }));
  };

  const updateText = (question: InteractionQuestion, value: string): void => {
    setTexts((current) => ({ ...current, [question.id]: value }));
    if (!question.multiSelect && value) setSelections((current) => ({ ...current, [question.id]: [] }));
  };

  const answersComplete = questions.every((question) =>
    (selections[question.id] ?? []).length > 0 || Boolean((texts[question.id] ?? "").trim())
  );

  const submit = async (): Promise<void> => {
    if (submitting || !answersComplete) return;
    const answers: Record<string, string[]> = {};
    for (const question of questions) {
      const values = [...(selections[question.id] ?? [])];
      const text = (texts[question.id] ?? "").trim();
      if (text) values.push(text);
      answers[question.id] = values;
    }
    setSubmitting(true);
    try {
      await respond(interaction.id, { outcome: "selected", answers });
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await respond(interaction.id, { outcome: "cancelled" });
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <CardShell
      icon={HelpCircle}
      tone={shell.tone}
      time={shell.time}
      title={
        <span className="inline-flex items-center gap-2">
          {t("sessions.interactions.question")}
          <StatusChip tone={shell.chipTone} label={shell.chipLabel} pulse={pending} />
        </span>
      }
    >
      <div className="space-y-4 rounded-xl border border-warn/25 bg-warn/5 px-4 py-3">
        {interaction.title && <p className="text-sm font-medium text-ink">{interaction.title}</p>}
        {questions.map((question) => (
          <QuestionField
            key={question.id}
            question={question}
            pending={pending}
            submitting={submitting}
            selected={selections[question.id] ?? []}
            text={texts[question.id] ?? ""}
            answered={interaction.response?.answers?.[question.id]}
            onToggle={(option) => toggleOption(question, option)}
            onText={(value) => updateText(question, value)}
          />
        ))}
        {pending && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" disabled={!answersComplete || submitting} onClick={() => void submit()}>
              <Send className="h-3.5 w-3.5" aria-hidden />
              {submitting ? t("sessions.interactions.submitting") : t("sessions.interactions.submit")}
            </Button>
            <Button variant="ghost" size="sm" disabled={submitting} onClick={() => void cancel()}>
              <X className="h-3.5 w-3.5" aria-hidden />
              {t("sessions.interactions.dismiss")}
            </Button>
          </div>
        )}
      </div>
    </CardShell>
  );
}

function QuestionField({
  question,
  pending,
  submitting,
  selected,
  text,
  answered,
  onToggle,
  onText
}: {
  question: InteractionQuestion;
  pending: boolean;
  submitting: boolean;
  selected: string[];
  text: string;
  answered?: string[];
  onToggle: (option: InteractionOption) => void;
  onText: (value: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const options = question.options ?? [];
  const showFreeText = options.length === 0 || question.isOther;

  if (!pending) {
    const values = answered ?? [];
    return (
      <div>
        <QuestionHeading question={question} />
        <p className="mt-1 text-[13px] text-ink-2">
          {values.length > 0
            ? `${t("sessions.interactions.yourAnswer")}: ${question.isSecret ? "••••••" : values.join(", ")}`
            : "—"}
        </p>
      </div>
    );
  }

  return (
    <fieldset disabled={submitting} className="min-w-0">
      <QuestionHeading question={question} />
      {options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" role={question.multiSelect ? "group" : "radiogroup"}>
          {options.map((option) => {
            const active = selected.includes(option.label);
            return (
              <button
                key={option.id}
                type="button"
                role={question.multiSelect ? "checkbox" : "radio"}
                aria-checked={active}
                title={option.description}
                onClick={() => onToggle(option)}
                className={cn(
                  "h-7.5 rounded-lg border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                  active
                    ? "border-accent/50 bg-accent-soft text-accent"
                    : "border-line bg-card text-ink-2 hover:border-accent/40 hover:text-ink"
                )}
              >
                {option.label}
              </button>
            );
          })}
          {question.multiSelect && (
            <span className="inline-flex h-7.5 items-center text-[11px] text-ink-3">{t("sessions.interactions.multiSelectHint")}</span>
          )}
        </div>
      )}
      {showFreeText && (
        <Input
          className="mt-2"
          type={question.isSecret ? "password" : "text"}
          value={text}
          placeholder={t(question.isSecret
            ? "sessions.interactions.secretPlaceholder"
            : options.length > 0
              ? "sessions.interactions.otherPlaceholder"
              : "sessions.interactions.freeTextPlaceholder")}
          onChange={(event) => onText(event.currentTarget.value)}
        />
      )}
    </fieldset>
  );
}

function QuestionHeading({ question }: { question: InteractionQuestion }): JSX.Element {
  return (
    <div className="flex items-start gap-2">
      {question.header && (
        <span className="mt-px inline-flex h-5 shrink-0 items-center rounded-md border border-line bg-card-hover px-1.5 text-[11px] font-medium text-ink-3">
          {question.header}
        </span>
      )}
      <p className="min-w-0 text-[13px] leading-relaxed font-medium text-ink">{question.question}</p>
    </div>
  );
}

function ApprovalCard({ interaction }: { interaction: InteractionRequest }): JSX.Element {
  const { t } = useI18n();
  const respond = useInteractionsStore((state) => state.respond);
  const shell = useInteractionShell(interaction);
  const options = interaction.options ?? [];
  const pending = interaction.status === "pending";
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const detail = interaction.detail ?? "";
  const collapsible = detail.length > 240;

  const answer = async (outcome: "selected" | "cancelled", optionId?: string): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await respond(interaction.id, { outcome, optionId });
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setSubmitting(false);
    }
  };

  const labelOf = (option: InteractionOption): string => {
    const key = APPROVAL_OPTION_KEYS[option.id];
    return key ? t(key) : option.label;
  };

  const firstAllowIndex = options.findIndex((option) => !isDangerOption(option));

  return (
    <CardShell
      icon={ShieldAlert}
      tone={shell.tone}
      time={shell.time}
      title={
        <span className="inline-flex items-center gap-2">
          {t("sessions.interactions.approval")}
          <StatusChip tone={shell.chipTone} label={shell.chipLabel} pulse={pending} />
        </span>
      }
    >
      <div className="rounded-xl border border-warn/25 bg-warn/5 px-4 py-3">
        <p className="text-sm font-medium text-ink">{interaction.title}</p>
        {detail && (
          <div className="mt-2">
            <pre className={cn(
              "overflow-x-auto rounded-lg border border-line bg-card px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-ink-2",
              collapsible && !expanded && "line-clamp-3"
            )}>
              {detail}
            </pre>
            {collapsible && (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/70"
              >
                {expanded
                  ? <><ChevronUp className="h-3 w-3" aria-hidden />{t("sessions.interactions.showLess")}</>
                  : <><ChevronDown className="h-3 w-3" aria-hidden />{t("sessions.interactions.showMore")}</>}
              </button>
            )}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {options.map((option, index) => (
            <Button
              key={option.id}
              variant={isDangerOption(option) ? "danger" : index === firstAllowIndex ? "primary" : "outline"}
              size="sm"
              title={option.description}
              disabled={submitting}
              onClick={() => void answer("selected", option.id)}
            >
              {labelOf(option)}
            </Button>
          ))}
          <Button variant="ghost" size="sm" disabled={submitting} onClick={() => void answer("cancelled")}>
            <X className="h-3.5 w-3.5" aria-hidden />
            {t("sessions.interactions.dismiss")}
          </Button>
        </div>
      </div>
    </CardShell>
  );
}

function PlanApprovalCard({ interaction }: { interaction: InteractionRequest }): JSX.Element {
  const { t } = useI18n();
  const respond = useInteractionsStore((state) => state.respond);
  const shell = useInteractionShell(interaction);
  const options = interaction.options ?? [];
  const pending = interaction.status === "pending";
  const plan = interaction.plan?.content.trim() ?? "";
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(plan.length < 1_800);

  const answer = async (optionId: string): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await respond(interaction.id, { outcome: "selected", optionId });
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setSubmitting(false);
    }
  };
  const cancel = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await respond(interaction.id, { outcome: "cancelled" });
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setSubmitting(false);
    }
  };

  const approve = options.find((option) => option.intent === "approve") ?? options.find((option) => !isDangerOption(option));
  const revise = options.find((option) => option.intent === "revise")
    ?? options.find((option) => option.intent === "reject")
    ?? options.find((option) => option.id !== approve?.id);
  const remaining = options.filter((option) => option.id !== approve?.id && option.id !== revise?.id);

  return (
    <CardShell
      icon={ClipboardCheck}
      tone="plan"
      time={shell.time}
      title={
        <span className="inline-flex items-center gap-2">
          {t("sessions.interactions.planApproval")}
          <StatusChip tone={shell.chipTone} label={shell.chipLabel} pulse={pending} />
        </span>
      }
    >
      <div className="overflow-hidden rounded-2xl border border-accent/25 bg-card shadow-[0_10px_35px_rgba(0,0,0,0.12)]">
        <div className="flex items-start justify-between gap-4 border-b border-line bg-gradient-to-r from-accent-soft to-transparent px-5 py-4">
          <div>
            <p className="text-[15px] font-semibold text-ink">{t("sessions.interactions.planReady")}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-3">{t("sessions.interactions.planReviewHint")}</p>
          </div>
          <span className="shrink-0 rounded-full border border-accent/25 bg-card px-2.5 py-1 text-[11px] font-medium text-accent">
            {interaction.providerId}
          </span>
        </div>

        {interaction.plan?.sourcePath && (
          <div className="min-w-0 break-all border-b border-line px-5 py-2 text-[11px] text-ink-3">
            {t("sessions.interactions.planSource")}: <code className="font-mono text-ink-2">{interaction.plan.sourcePath}</code>
          </div>
        )}

        <div className="relative px-5 py-4">
          {plan
            ? (
              <div className={cn("relative", !expanded && "max-h-80 overflow-hidden")}>
                <MarkdownContent source={plan} />
                {!expanded && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-card to-transparent" />
                )}
              </div>
            )
            : <p className="rounded-xl border border-line bg-card-hover px-4 py-3 text-sm text-ink-3">{t("sessions.interactions.planUnavailable")}</p>}
          {plan.length >= 1_800 && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/70"
            >
              {expanded
                ? <><ChevronUp className="h-3.5 w-3.5" aria-hidden />{t("sessions.interactions.showLess")}</>
                : <><ChevronDown className="h-3.5 w-3.5" aria-hidden />{t("sessions.interactions.showMore")}</>}
            </button>
          )}
        </div>

        {pending && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-card-hover/50 px-5 py-3.5">
            {approve && (
              <Button variant="primary" size="sm" disabled={submitting} title={approve.description} onClick={() => void answer(approve.id)}>
                <Check className="h-3.5 w-3.5" aria-hidden />
                {t("sessions.interactions.approvePlan")}
              </Button>
            )}
            {revise && (
              <Button variant="outline" size="sm" disabled={submitting} title={revise.description} onClick={() => void answer(revise.id)}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                {t("sessions.interactions.revisePlan")}
              </Button>
            )}
            {!revise && (
              <Button variant="outline" size="sm" disabled={submitting} onClick={() => void cancel()}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                {t("sessions.interactions.revisePlan")}
              </Button>
            )}
            {remaining.map((option) => (
              <Button
                key={option.id}
                variant={isDangerOption(option) ? "danger" : "outline"}
                size="sm"
                disabled={submitting}
                title={option.description}
                onClick={() => void answer(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </CardShell>
  );
}
