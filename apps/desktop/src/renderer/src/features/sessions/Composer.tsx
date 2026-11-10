import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import type { SlashCommandDefinition } from "@agenthub/domain";
import { ArrowUp, FileText, Loader2, Plus, SendHorizontal, Square, X } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { sendWorkbenchFollowUp, sendWorkbenchMessage, stopWorkbenchRun } from "../../lib/orchestration-runtime";
import { getBridge } from "../../lib/bridge";
import { connectionSendError } from "../../lib/session-connections";
import { artifactUrlForPath } from "../timeline/media-actions";
import type { DesktopAttachment } from "../../types/bridge";
import { deliverComposerSubmission, EMPTY_COMPOSER_DRAFT, useComposerDraftsStore, type ComposerSubmission } from "../../stores/composer-drafts";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { filterSnippets, snippetQuery } from "../../lib/snippets";
import { toast } from "../../stores/toast";
import { SessionPermissionControl } from "./PermissionModeSelect";
import { SessionModelControl } from "./SessionModelControl";
import { ContextUsageIndicator, useContextUsage } from "./ContextUsageIndicator";
import { CommandResultDialog } from "./slash-commands/CommandResultDialog";
import { SlashCommandMenu } from "./slash-commands/SlashCommandMenu";
import { SnippetMenu } from "./slash-commands/SnippetMenu";
import { filterSlashCommands, parseSlashCommand, slashCommandQuery } from "./slash-commands/slash-command-utils";
import { useSlashCommands } from "./slash-commands/useSlashCommands";
import { QueuedFollowUpBar } from "./QueuedFollowUpBar";
import { SessionHarnessModeControl } from "./HarnessModeControl";


/** Chat composer plus per-session model/effort controls, matching the Codex interaction model. */
export function Composer({
  sessionId,
  targetName,
  running,
  disabled,
  submissionDisabledReason,
  onCreateSession,
  starterControls,
  trailingControls,
  draftId
}: {
  sessionId?: string;
  targetName?: string;
  running: boolean;
  disabled?: boolean;
  /** Configuration can block sending while the user continues writing a draft. */
  submissionDisabledReason?: string;
  /** The landing creates a real session only when its first message is sent. */
  onCreateSession?: (text: string) => string | undefined;
  starterControls?: ReactNode;
  trailingControls?: ReactNode;
  /** Distinguishes independent new Code and Work drafts. */
  draftId?: string;
}): JSX.Element {
  const { t, locale } = useI18n();
  const draftKey = sessionId ?? draftId ?? "new";
  const draft = useComposerDraftsStore((state) => state.drafts[draftKey] ?? EMPTY_COMPOSER_DRAFT);
  const value = draft.text;
  const attachments = draft.attachments;
  const updateText = useComposerDraftsStore((state) => state.setText);
  const updateAttachments = useComposerDraftsStore((state) => state.setAttachments);
  const submitting = useComposerDraftsStore((state) => !!state.pending[draftKey]);
  const failedSubmissions = useComposerDraftsStore((state) => state.failed[draftKey]);
  const setValue = (text: string): void => updateText(draftKey, text);
  const setAttachments = (next: DesktopAttachment[] | ((current: DesktopAttachment[]) => DesktopAttachment[])): void => updateAttachments(draftKey, next);
  const [importing, setImporting] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editingMessage = useSessionsStore((state) => state.editingMessage?.sessionId === sessionId ? state.editingMessage : undefined);
  const cancelEditingMessage = useSessionsStore((state) => state.cancelEditingMessage);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const slash = useSlashCommands(sessionId);
  const promptSnippets = useSettingsStore((state) => state.promptSnippets);
  const snippetQ = snippetQuery(value);
  const filteredSnippets = useMemo(
    () => snippetQ !== undefined ? filterSnippets(promptSnippets, snippetQ) : [],
    [snippetQ, promptSnippets]
  );
  const snippetMenuOpen = snippetQ !== undefined && filteredSnippets.length > 0;
  const commandQuery = snippetQ !== undefined ? undefined : slashCommandQuery(value);
  const filteredCommands = useMemo(
    () => commandQuery ? filterSlashCommands(slash.commands, commandQuery) : [],
    [commandQuery, slash.commands]
  );
  const commandMenuOpen = commandQuery !== undefined && slash.commands.length > 0;
  // Native context compaction: providers whose catalog exposes /compact
  // (kimi/claude/codex/opencode) get the button; others hide it.
  const compactCommand = useMemo(
    () => slash.commands.find((command) => command.name === "/compact" || command.id.toLowerCase().includes("compact")),
    [slash.commands]
  );
  const { percentage: contextPercentage } = useContextUsage(sessionId);
  // Dismissal remembers the level it was dismissed at; the banner comes back
  // once usage climbs another 5 points (or after a successful compact).
  const [compactDismissedAt, setCompactDismissedAt] = useState<Record<string, number>>({});
  const dismissedAt = sessionId ? compactDismissedAt[sessionId] : undefined;
  const compactBannerVisible = !!compactCommand
    && contextPercentage !== undefined
    && contextPercentage >= 85
    && !(dismissedAt !== undefined && contextPercentage < dismissedAt + 5);

  const runCompact = useMemo(
    () => compactCommand ? (): void => {
      void slash.execute(compactCommand).then((ok) => {
        if (ok) {
          toast.success(t("sessions.composer.compactDone"));
          if (sessionId) setCompactDismissedAt((current) => ({ ...current, [sessionId]: 100 }));
        } else {
          toast.error(t("sessions.composer.compactFailed"));
        }
      });
    } : undefined,
    [compactCommand, slash.execute, sessionId, t]
  );

  useEffect(() => setActiveCommandIndex(0), [commandQuery, snippetQ, sessionId]);
  useEffect(() => {
    setAttachmentError(undefined);
  }, [sessionId]);
  useEffect(() => {
    if (!editingMessage) return;
    setValue(editingMessage.text);
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(editingMessage.text.length, editingMessage.text.length);
  }, [editingMessage]);
  // Queued follow-ups live in the sessions store (daemon queue + events).

  const canCompose = !!sessionId || !!onCreateSession;
  const canSend = canCompose && !submitting && !running && !importing && (value.trim().length > 0 || attachments.length > 0) && !disabled && !submissionDisabledReason;
  const canFollowUp = !!sessionId && !submitting && running && !importing && !disabled && !editingMessage && attachments.length === 0 && value.trim().length > 0;

  const appendAttachments = (next: DesktopAttachment[]): void => {
    setAttachments((current) => {
      const unique = new Map(current.map((attachment) => [attachment.path, attachment]));
      for (const attachment of next) unique.set(attachment.path, attachment);
      return [...unique.values()].slice(0, 10);
    });
    setAttachmentError(undefined);
  };
  const pickFiles = async (): Promise<void> => {
    const bridge = getBridge();
    if (!bridge) return;
    setImporting(true);
    try {
      appendAttachments(await bridge.dialog.pickFiles());
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  };
  const importClipboardFiles = async (files: File[]): Promise<void> => {
    const bridge = getBridge();
    if (!bridge || files.length === 0) return;
    setImporting(true);
    setAttachmentError(undefined);
    try {
      const imported: DesktopAttachment[] = [];
      for (const file of files.slice(0, 10)) {
        let path = "";
        try {
          path = bridge.attachments.pathForFile(file);
        } catch {
          // Clipboard screenshots have no filesystem path; import their bytes below.
        }
        if (path) imported.push(...await bridge.attachments.describePaths([path]));
        else imported.push(await bridge.attachments.importClipboard({ name: file.name || "clipboard-image.png", mimeType: file.type || undefined, data: new Uint8Array(await file.arrayBuffer()) }));
      }
      appendAttachments(imported);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  };

  const runCommand = (command: SlashCommandDefinition, argument?: string): void => {
    if (!sessionId) return;
    if (command.argumentRequired && !argument) {
      setValue(`${command.name} `);
      return;
    }
    void slash.execute(command, argument);
    setValue("");
  };
  const tryRunSlashCommand = (): boolean => {
    const parsed = attachments.length === 0 ? parseSlashCommand(value, slash.commands) : undefined;
    if (parsed && (parsed.command.availability === "always" || !running)) {
      runCommand(parsed.command, parsed.argument);
      return true;
    }
    return false;
  };
  const dispatchSubmission = (kind: ComposerSubmission["kind"], retryToken?: number): void => {
    if (disabled || submissionDisabledReason) return;
    const store = useComposerDraftsStore.getState();
    let submission = store.begin(draftKey, kind, editingMessage?.messageId, retryToken);
    if (!submission) return; // Atomic across double-clicks and mounted composers.
    if (retryToken !== undefined && submission.kind !== "message" && !running) submission = { ...submission, kind: "message" };
    try {
      const destinationId = sessionId ?? onCreateSession?.(submission.draft.text.trim());
      if (!destinationId) throw new Error(locale === "zh-CN" ? "未能创建会话，内容已保留" : "Could not create the conversation. Your draft is retained.");
      submission = store.move(submission, destinationId);
      const sent = submission;
      void deliverComposerSubmission(sent, async () => {
        const text = sent.draft.text.trim() || t("sessions.composer.attachmentPrompt");
        if (sent.kind === "message") {
          await sendWorkbenchMessage(destinationId, text, sent.draft.attachments, sent.editMessageId);
          // Do not cancel a different edit the user began while awaiting IPC.
          const currentEdit = useSessionsStore.getState().editingMessage;
          if (sent.editMessageId && currentEdit?.sessionId === destinationId && currentEdit.messageId === sent.editMessageId && useComposerDraftsStore.getState().drafts[destinationId] === sent.draft) cancelEditingMessage();
        } else {
          const appliedMode = await sendWorkbenchFollowUp(destinationId, text, sent.kind);
          if (!appliedMode) throw new Error(locale === "zh-CN" ? "追加消息未被接受，内容已保留" : "Follow-up was not accepted. Your draft is retained.");
          if (sent.kind === "steer" && appliedMode === "queue") toast.info(t("sessions.composer.steerDowngraded"));
        }
      });
    } catch (error) {
      store.finish(submission, error instanceof Error ? error.message : String(error));
    }
  };
  const submit = (): void => {
    if (submitting) return;
    if (sessionId && tryRunSlashCommand()) return;
    if (running) submitFollowUp("steer");
    else if (canSend) dispatchSubmission("message");
  };
  const submitFollowUp = (mode: "steer" | "queue"): void => {
    if (sessionId && canFollowUp) dispatchSubmission(mode);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter confirms IME composition before it may submit a message.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (snippetMenuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveCommandIndex((current) => filteredSnippets.length ? (current + 1) % filteredSnippets.length : 0);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveCommandIndex((current) => filteredSnippets.length ? (current - 1 + filteredSnippets.length) % filteredSnippets.length : 0);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setValue("");
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && filteredSnippets[activeCommandIndex]) {
        event.preventDefault();
        setValue(filteredSnippets[activeCommandIndex].text);
        return;
      }
    }
    if (commandMenuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveCommandIndex((current) => filteredCommands.length ? (current + 1) % filteredCommands.length : 0);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveCommandIndex((current) => filteredCommands.length ? (current - 1 + filteredCommands.length) % filteredCommands.length : 0);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setValue("");
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && filteredCommands[activeCommandIndex]) {
        event.preventDefault();
        runCommand(filteredCommands[activeCommandIndex]);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (running) submitFollowUp("queue");
      else submit();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
    event.preventDefault();
    void importClipboardFiles(files);
  };
  return (
    <div data-tour="sessions-composer" className={sessionId ? "composer shrink-0 bg-card px-4 pb-5 pt-3 sm:px-7" : "composer w-full shrink-0 bg-card"}>
      {sessionId && <QueuedFollowUpBar sessionId={sessionId} disabled={disabled} />}
      <div
        className={cn(
          "composer-box relative mx-auto w-full max-w-3xl rounded-2xl border border-line-strong bg-card shadow-[0_2px_10px_rgba(0,0,0,0.045)] transition-[border-color,box-shadow] duration-150 focus-within:border-ink-3/50 focus-within:shadow-[0_2px_14px_rgba(0,0,0,0.06)]"
        )}
      >
        <AnimatePresence>
          {snippetMenuOpen && (
            <SnippetMenu
              snippets={filteredSnippets}
              activeIndex={activeCommandIndex}
              onActiveIndexChange={setActiveCommandIndex}
              onSelect={(snippet) => setValue(snippet.text)}
            />
          )}
          {commandMenuOpen && (
            <SlashCommandMenu
              commands={filteredCommands}
              activeIndex={activeCommandIndex}
              onActiveIndexChange={setActiveCommandIndex}
              onSelect={runCommand}
            />
          )}
        </AnimatePresence>
        {compactBannerVisible && (
          <div className="mx-3 mt-3 flex items-center gap-2 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-ink-2">
            <span className="min-w-0 flex-1 truncate">{t("sessions.composer.compactSuggest", { percent: Math.round(contextPercentage ?? 0) })}</span>
            <button
              type="button"
              onClick={runCompact}
              disabled={slash.loading}
              className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-warn/40 bg-card px-2.5 text-[11px] font-medium text-warn transition-colors hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/35 disabled:opacity-40"
            >
              {slash.loading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
              {t("sessions.composer.compactNow")}
            </button>
            <button
              type="button"
              onClick={() => sessionId && setCompactDismissedAt((current) => ({ ...current, [sessionId]: contextPercentage ?? 100 }))}
              className="rounded-md p-1 text-ink-3 transition-colors hover:bg-card-hover hover:text-ink"
              aria-label={t("sessions.composer.cancelEdit")}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        )}
        {editingMessage && (
          <div className="mx-3 mt-3 flex items-center gap-2 rounded-xl border border-accent/20 bg-accent-soft px-3 py-2 text-xs text-ink-2">
            <span className="min-w-0 flex-1 truncate">{t("sessions.composer.editing")}</span>
            <button type="button" onClick={cancelEditingMessage} className="rounded-md p-1 text-ink-3 transition-colors hover:bg-card-hover hover:text-ink" aria-label={t("sessions.composer.cancelEdit")}>
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3">
            {attachments.map((attachment) => (
              <div key={attachment.path} className="group relative flex h-16 min-w-[154px] max-w-[220px] items-center gap-2.5 rounded-xl border border-line bg-card-hover px-2.5">
                {attachment.kind === "image" ? (
                  <img src={artifactUrlForPath(attachment.path)} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
                ) : (
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-info/10 text-info"><FileText className="h-5 w-5" aria-hidden /></span>
                )}
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-ink-2">{attachment.name}</p>
                  <p className="mt-0.5 text-[10px] text-ink-3">{formatFileSize(attachment.sizeBytes)}</p>
                </div>
                <button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.path !== attachment.path))} className="absolute right-1 top-1 rounded-full bg-card/90 p-1 text-ink-3 opacity-60 shadow-sm transition-opacity hover:text-danger group-hover:opacity-100 focus-visible:opacity-100" aria-label={t("sessions.composer.removeAttachment")}>
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={2}
          disabled={!canCompose || disabled}
          placeholder={locale === "zh-CN" ? "今天帮你做些什么？输入任务，或添加文件" : "What can I help with? Describe a task, or add files"}
          aria-label={t("sessions.composer.placeholder", { name: targetName ?? "Agent" })}
          className="block max-h-48 min-h-[76px] w-full resize-none rounded-t-2xl bg-transparent px-4 pb-2 pt-4 text-[14px] leading-6 text-ink outline-none placeholder:text-ink-3/70 disabled:opacity-50"
        />
        {failedSubmissions?.map((failedSubmission) => <div key={failedSubmission.submission.token} role="alert" className="flex flex-wrap items-center gap-2 px-4 pb-2 text-xs text-danger">
          <span className="min-w-0 flex-1" title={failedSubmission.submission.draft.text}>{connectionSendError(failedSubmission.error, locale === "zh-CN")} · {failedSubmission.submission.draft.text.slice(0, 48) || (locale === "zh-CN" ? "附件" : "Attachments")}</span>
          <button type="button" disabled={submitting || disabled || !!submissionDisabledReason || (failedSubmission.submission.kind === "message" && running)} onClick={() => dispatchSubmission(failedSubmission.submission.kind, failedSubmission.submission.token)} className="rounded px-2 py-1 text-ink-2 underline disabled:opacity-40">{failedSubmission.submission.kind !== "message" && !running ? (locale === "zh-CN" ? "作为新消息重试" : "Retry as new message") : (locale === "zh-CN" ? "重试未发送内容" : "Retry unsent content")}</button>
        </div>)}
        {attachmentError && <p className="px-4 pb-1 text-[11px] text-danger">{attachmentError}</p>}
        <div className="composer-toolbar flex min-h-11 flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
          <button type="button" onClick={() => void pickFiles()} disabled={!canCompose || disabled || importing || running} className="composer-attach flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-card-hover hover:text-ink disabled:opacity-40" aria-label={t("sessions.composer.addAttachment")} title={t("sessions.composer.addAttachment")}>
            {importing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-[18px] w-[18px]" aria-hidden />}
          </button>
          {sessionId ? <SessionPermissionControl sessionId={sessionId} disabled={running || disabled} /> : starterControls}
          {sessionId && <SessionHarnessModeControl sessionId={sessionId} disabled={running || disabled} />}
          <span className="min-w-0 flex-1" />
          {sessionId ? <SessionModelControl sessionId={sessionId} disabled={running || disabled} /> : trailingControls}
          <ContextUsageIndicator
            sessionId={sessionId}
            compactCommand={compactCommand}
            onCompact={runCompact}
            compactDisabled={!sessionId || disabled || running || slash.loading}
            compactLoading={slash.loading}
          />
          {(!running || value.trim().length > 0 || attachments.length > 0 || submitting) && (
            <button
              type="button"
              onClick={submit}
              disabled={running ? !canFollowUp : !canSend}
              aria-label={t(running ? "sessions.composer.steer" : "sessions.composer.send")}
              title={submissionDisabledReason ?? t(running ? "sessions.composer.runningHint" : "sessions.composer.send")}
              className="composer-send flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-canvas shadow-sm transition-[transform,opacity,background-color] hover:bg-ink-2 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : sessionId ? <ArrowUp className="h-4 w-4 stroke-[2.4]" aria-hidden /> : <SendHorizontal className="h-5 w-5" aria-hidden />}
            </button>
          )}
          {running && (
            <button
              type="button"
              onClick={() => sessionId && void stopWorkbenchRun(sessionId)}
              aria-label={t("sessions.composer.stop")}
              title={t("sessions.composer.stop")}
              className="composer-stop flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line-strong bg-ink text-canvas transition-colors hover:bg-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-3/50"
            >
              <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
            </button>
          )}
        </div>
      </div>
      <CommandResultDialog
        result={slash.result}
        loading={slash.loading}
        error={slash.error}
        onClose={slash.closeResult}
        onAction={(actionId, selectedOptionIds) => void slash.continueCommand(actionId, selectedOptionIds)}
      />
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
