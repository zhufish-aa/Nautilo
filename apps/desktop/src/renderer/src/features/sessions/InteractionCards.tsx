import { useEffect, useState } from "react";
import { ArrowRight, Check, ChevronDown, ChevronUp, ClipboardCheck, ExternalLink, HelpCircle, Pencil, RotateCcw, Send, ShieldAlert, X, type LucideIcon } from "lucide-react";
import type { InteractionOption, InteractionQuestion, InteractionRequest, InteractionResponse } from "@agenthub/domain";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { cn, formatDateTime } from "../../lib/utils";
import { useInteractionsStore } from "../../stores/interactions";
import { toast } from "../../stores/toast";
import { getBridge } from "../../lib/bridge";
import { StatusChip, type ChipTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { MarkdownContent } from "../timeline/MarkdownContent";
import { PluginApprovalCard, pluginPresentation } from "./PluginApprovalCard";
import "./interaction-question.css";

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
export function InteractionCards({ sessionId, interactionId }: { sessionId: string; interactionId?: string }): JSX.Element | null {
  const interactions = useInteractionsStore((state) => state.bySession[sessionId] ?? EMPTY);
  const loadPending = useInteractionsStore((state) => state.loadPending);
  const respondInteraction = useInteractionRespond();

  useEffect(() => {
    if (!interactionId) void loadPending(sessionId);
  }, [sessionId, loadPending, interactionId]);

  const visible = interactions.filter((interaction) => (!interactionId || interaction.id === interactionId) && (interaction.kind === "question" || interaction.status === "pending"));
  if (visible.length === 0) return null;
  return (
    <>
      {visible.map((interaction) => {
        const presentation = pluginPresentation(interaction);
        return presentation ? <PluginApprovalCard key={interaction.id} interaction={interaction} presentation={presentation} onRespond={respondInteraction} /> : interaction.kind === "question"
          ? <QuestionCard key={interaction.id} interaction={interaction} />
          : interaction.kind === "plan_approval"
            ? <PlanApprovalCard key={interaction.id} interaction={interaction} />
            : <ApprovalCard key={interaction.id} interaction={interaction} />
      })}
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
  return (
    <article className="min-w-0 py-2" data-tone={tone}>
      <div className="mb-3 flex items-center gap-2 text-sm text-ink-2" title={time}>
        <Icon className="h-4 w-4 text-ink-3" aria-hidden />{title}
      </div>
      {children}
    </article>
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

/** The daemon no longer holds this interaction (auto-cancelled or resolved elsewhere). */
function isExpiredError(error: unknown): boolean {
  return messageOf(error).includes("已过期");
}

/** Shared respond error handling: expired cards get dismissed, not just toasted. */
function useInteractionRespond(): (interaction: InteractionRequest, response: InteractionResponse) => Promise<void> {
  const respond = useInteractionsStore((state) => state.respond);
  const remove = useInteractionsStore((state) => state._remove);
  return async (interaction, response) => {
    try {
      await respond(interaction.id, response);
    } catch (error) {
      if (isExpiredError(error)) remove(interaction.sessionId, interaction.id);
      else toast.error(messageOf(error));
    }
  };
}

function QuestionCard({ interaction }: { interaction: InteractionRequest }): JSX.Element {
  const { t, locale } = useI18n();
  const respondInteraction = useInteractionRespond();
  const questions = interaction.questions ?? [];
  const pending = interaction.status === "pending";

  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(questions.map(question => [question.id, question.initialValue ?? ""])));
  const [submitting, setSubmitting] = useState(false);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!pending || !interaction.timeoutMs) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending, interaction.timeoutMs]);
  const seconds = interaction.timeoutMs ? Math.max(0, Math.ceil((Date.parse(interaction.createdAt) + interaction.timeoutMs - clock) / 1000)) : undefined;

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
    question.allowEmpty || (selections[question.id] ?? []).length > 0 || Boolean((texts[question.id] ?? "").trim())
  );

  const submit = async (): Promise<void> => {
    if (submitting || !answersComplete) return;
    const answers: Record<string, string[]> = {};
    for (const question of questions) {
      const values = [...(selections[question.id] ?? [])];
      const original = texts[question.id] ?? "";
      const text = question.preserveWhitespace ? original : original.trim();
      if (text || question.allowEmpty && !(question.options?.length)) values.push(text);
      answers[question.id] = values;
    }
    setSubmitting(true);
    await respondInteraction(interaction, { outcome: "selected", answers });
    setSubmitting(false);
  };

  const cancel = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    await respondInteraction(interaction, { outcome: "cancelled" });
    setSubmitting(false);
  };

  return (
    <section className="interaction-question" aria-label={t("sessions.interactions.question")}>
      <div className="interaction-question-heading">
        <p>{questions.length === 1 ? questions[0]!.question : interaction.title || t("sessions.interactions.question")}</p>
        {pending && seconds !== undefined && Number.isFinite(seconds) && <span className="interaction-question-timer">{seconds}s</span>}
        {pending && <button type="button" aria-label={t("sessions.interactions.dismiss")} disabled={submitting} onClick={() => void cancel()}><X size={16} /></button>}
      </div>
      <div className="interaction-question-fields">
        {questions.map((question) => (
          <QuestionField
            key={question.id}
            question={question}
            hideHeading={questions.length === 1}
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
          <div className="interaction-question-actions">
            <button className="interaction-question-skip" type="button" disabled={submitting} onClick={() => void cancel()}>{locale === "zh-CN" ? "跳过" : "Skip"}</button>
            <button className="interaction-question-submit" type="button" aria-label={t("sessions.interactions.submit")} disabled={!answersComplete || submitting} onClick={() => void submit()}>
              {submitting ? t("sessions.interactions.submitting") : <><Send size={15} />{questions.length > 1 && t("sessions.interactions.submit")}</>}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function QuestionField({
  question,
  hideHeading = false,
  pending,
  submitting,
  selected,
  text,
  answered,
  onToggle,
  onText
}: {
  question: InteractionQuestion;
  hideHeading?: boolean;
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
        {!hideHeading && <QuestionHeading question={question} />}
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
      {!hideHeading && <QuestionHeading question={question} />}
      {options.length > 0 && (
        <div className="interaction-question-options" role={question.multiSelect ? "group" : "radiogroup"}>
          {options.map((option, index) => {
            const active = selected.includes(option.label);
            return (
              <button
                key={option.id}
                type="button"
                role={question.multiSelect ? "checkbox" : "radio"}
                aria-checked={active}
                title={option.description}
                onClick={() => onToggle(option)}
                className="interaction-question-option" data-active={active}
              >
                <span className="interaction-question-number" data-first={index === 0}>{index + 1}</span>
                <span className="interaction-question-option-copy">{option.label}{option.description && <small>{option.description}</small>}</span>
                <ArrowRight size={17} className="interaction-question-arrow" aria-hidden />
              </button>
            );
          })}
          {question.multiSelect && (
            <span className="inline-flex h-7.5 items-center text-[11px] text-ink-3">{t("sessions.interactions.multiSelectHint")}</span>
          )}
        </div>
      )}
      {showFreeText && <div className="interaction-question-input"><Pencil size={16} aria-hidden />{question.inputType === "multiline" ? (
        <textarea className="interaction-question-answer" rows={4}
          aria-label={question.question} value={text} placeholder={question.placeholder}
          onChange={event => onText(event.currentTarget.value)} />
      ) : (
        <input className="interaction-question-answer" aria-label={question.question} type={question.isSecret ? "password" : "text"}
          value={text} placeholder={question.placeholder ?? t(question.isSecret ? "sessions.interactions.secretPlaceholder"
            : options.length > 0 ? "sessions.interactions.otherPlaceholder" : "sessions.interactions.freeTextPlaceholder")}
          onChange={event => onText(event.currentTarget.value)} />
      )}</div>}
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
  const respondInteraction = useInteractionRespond();
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
    await respondInteraction(interaction, { outcome, optionId });
    setSubmitting(false);
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
      <div className="rounded-xl border border-line bg-panel px-5 py-4">
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
        {interaction.links?.length ? <div className="mt-3 flex flex-wrap gap-2">{interaction.links.map((link) => <Button key={link.url} variant="outline" size="sm" onClick={() => {
          const bridge = getBridge();
          if (bridge) void bridge.shell.openExternal(link.url).catch((error) => toast.error(String(error)));
        }}><ExternalLink className="h-3.5 w-3.5" aria-hidden />{link.label}</Button>)}</div> : null}
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
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <p className="text-[15px] font-semibold text-ink">{t("sessions.interactions.planReady")}</p>

          </div>
          <span className="shrink-0 rounded-full border border-line bg-panel px-2.5 py-1 text-xs font-medium text-ink-2">
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
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-line" />
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
          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-panel px-5 py-3.5">
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
