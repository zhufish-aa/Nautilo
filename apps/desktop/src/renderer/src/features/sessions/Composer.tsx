import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { AnimatePresence } from "framer-motion";
import type { SlashCommandDefinition } from "@agenthub/domain";
import { ArrowUp, FileText, ListPlus, Loader2, Paperclip, SendHorizontal, Square, X } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { sendWorkbenchFollowUp, sendWorkbenchMessage, stopWorkbenchRun } from "../../lib/orchestration-runtime";
import { getBridge } from "../../lib/bridge";
import type { DesktopAttachment } from "../../types/bridge";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { filterSnippets, snippetQuery } from "../../lib/snippets";
import { toast } from "../../stores/toast";
import { PlanModeToggle } from "./PlanModeToggle";
import { SessionModelControl } from "./SessionModelControl";
import { ContextUsageIndicator, useContextUsage } from "./ContextUsageIndicator";
import { CommandResultDialog } from "./slash-commands/CommandResultDialog";
import { SlashCommandMenu } from "./slash-commands/SlashCommandMenu";
import { SnippetMenu } from "./slash-commands/SnippetMenu";
import { filterSlashCommands, parseSlashCommand, slashCommandQuery } from "./slash-commands/slash-command-utils";
import { useSlashCommands } from "./slash-commands/useSlashCommands";

const EMPTY_LIST: never[] = [];

/** Chat composer plus per-session model/effort controls, matching the Codex interaction model. */
export function Composer({
  sessionId,
  targetName,
  running,
  disabled
}: {
  sessionId?: string;
  targetName?: string;
  running: boolean;
  disabled?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<DesktopAttachment[]>([]);
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

  const [queuedCounts, setQueuedCounts] = useState<Record<string, number>>({});

  useEffect(() => setActiveCommandIndex(0), [commandQuery, snippetQ, sessionId]);
  useEffect(() => {
    setValue("");
    setAttachments([]);
    setAttachmentError(undefined);
  }, [sessionId]);
  useEffect(() => {
    if (!editingMessage) return;
    setValue(editingMessage.text);
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(editingMessage.text.length, editingMessage.text.length);
  }, [editingMessage]);
  // Queued follow-ups are consumed by the runtime once the run settles; clear the local badge.
  useEffect(() => {
    if (running || !sessionId) return;
    setQueuedCounts((current) => (current[sessionId] ? { ...current, [sessionId]: 0 } : current));
  }, [running, sessionId]);

  const canSend = !!sessionId && !running && !importing && (value.trim().length > 0 || attachments.length > 0) && !disabled;
  const queuedCount = sessionId ? queuedCounts[sessionId] ?? 0 : 0;
  const canFollowUp = !!sessionId && running && !importing && !disabled && !editingMessage && attachments.length === 0 && value.trim().length > 0;

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
    try {
      appendAttachments(await bridge.dialog.pickFiles());
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
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
  const submit = (): void => {
    if (!sessionId) return;
    if (tryRunSlashCommand()) return;
    if (!canSend) return;
    const text = value.trim() || t("sessions.composer.attachmentPrompt");
    const edit = editingMessage;
    setValue("");
    setAttachments([]);
    if (edit) cancelEditingMessage();
    void sendWorkbenchMessage(sessionId, text, attachments, edit?.messageId);
  };
  const submitFollowUp = (mode: "steer" | "queue"): void => {
    if (!sessionId || !canFollowUp) return;
    const targetSessionId = sessionId;
    const text = value.trim();
    setValue("");
    void sendWorkbenchFollowUp(targetSessionId, text, mode)
      .then((appliedMode) => {
        // Steer may have been downgraded to queue by the daemon (non-Codex CLIs).
        if (appliedMode === "queue") setQueuedCounts((current) => ({ ...current, [targetSessionId]: (current[targetSessionId] ?? 0) + 1 }));
      })
      .catch((error) => setAttachmentError(error instanceof Error ? error.message : String(error)));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
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
      if (running) {
        if (tryRunSlashCommand()) return;
        submitFollowUp("steer");
        return;
      }
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
    <div className="shrink-0 border-t border-line/70 bg-panel/95 px-5 pb-4 pt-3 backdrop-blur-xl">
      <div
        className={cn(
          "relative mx-auto w-full max-w-4xl rounded-2xl border bg-card transition-[border-color,box-shadow] duration-300",
          running
            ? "run-border border-accent/40 shadow-[0_18px_52px_-18px_var(--accent)]"
            : "border-line-strong shadow-[0_12px_36px_-24px_rgba(15,23,42,0.42)] focus-within:border-accent/50 focus-within:shadow-[0_0_0_1px_var(--accent-soft),0_18px_48px_-20px_var(--accent)]"
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
                  <img src={`agenthub-artifact://local/?path=${encodeURIComponent(attachment.path)}`} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
                ) : (
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-info/10 text-info"><FileText className="h-5 w-5" aria-hidden /></span>
                )}
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-ink-2">{attachment.name}</p>
                  <p className="mt-0.5 text-[10px] text-ink-3">{formatFileSize(attachment.sizeBytes)}</p>
                </div>
                <button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.path !== attachment.path))} className="absolute right-1 top-1 rounded-full bg-card/90 p-1 text-ink-3 opacity-0 shadow-sm transition-opacity hover:text-danger group-hover:opacity-100" aria-label={t("sessions.composer.removeAttachment")}>
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
          disabled={!sessionId || disabled}
          placeholder={t("sessions.composer.placeholder", { name: targetName ?? "Agent" })}
          aria-label={t("sessions.composer.placeholder", { name: targetName ?? "Agent" })}
          className="block max-h-48 min-h-[58px] w-full resize-none rounded-t-2xl bg-transparent px-4 pb-1.5 pt-3.5 font-mono text-[13px] leading-6 text-ink outline-none placeholder:font-sans placeholder:text-sm placeholder:text-ink-3/65 disabled:opacity-50"
        />
        {attachmentError && <p className="px-4 pb-1 text-[11px] text-danger">{attachmentError}</p>}
        <div className="flex min-h-11 items-center gap-3 px-3 pb-2.5">
          <button type="button" onClick={() => void pickFiles()} disabled={!sessionId || disabled || importing || running} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-card-hover hover:text-ink disabled:opacity-40" aria-label={t("sessions.composer.addAttachment")} title={t("sessions.composer.addAttachment")}>
            {importing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Paperclip className="h-4 w-4" aria-hidden />}
          </button>
          <p className="min-w-0 flex-1 truncate px-1 text-[11px] text-ink-3">{running ? t("sessions.composer.runningHint") : t("sessions.composer.hint")}</p>
          <PlanModeToggle sessionId={sessionId} disabled={running || disabled} />
          <SessionModelControl sessionId={sessionId} disabled={running || disabled} />
          <ContextUsageIndicator
            sessionId={sessionId}
            compactCommand={compactCommand}
            onCompact={runCompact}
            compactDisabled={!sessionId || disabled || running || slash.loading}
            compactLoading={slash.loading}
          />
          {running ? (
            <>
              <button
                type="button"
                onClick={() => submitFollowUp("queue")}
                disabled={!canFollowUp}
                aria-label={t("sessions.composer.queue")}
                title={t("sessions.composer.queueTitle")}
                className="relative flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line-strong bg-card px-3 text-xs font-medium text-ink-2 transition-colors hover:bg-card-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ListPlus className="h-3.5 w-3.5" aria-hidden />
                {t("sessions.composer.queue")}
                {queuedCount > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-info px-1 text-[10px] font-semibold text-white">
                    {queuedCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => submitFollowUp("steer")}
                disabled={!canFollowUp}
                aria-label={t("sessions.composer.steer")}
                title={t("sessions.composer.steerTitle")}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-ink px-3.5 text-xs font-medium text-canvas shadow-sm transition-[transform,opacity,background-color] hover:-translate-y-0.5 hover:bg-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <SendHorizontal className="h-3.5 w-3.5 stroke-[2.4]" aria-hidden />
                {t("sessions.composer.steer")}
              </button>
              <button
                type="button"
                onClick={() => sessionId && void stopWorkbenchRun(sessionId)}
                aria-label={t("sessions.composer.stop")}
                title={t("sessions.composer.stop")}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-danger/35 bg-danger/10 text-danger shadow-[0_0_18px_-6px_var(--danger)] transition-colors hover:bg-danger/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/35"
              >
                <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label={t("sessions.composer.send")}
              title={t("sessions.composer.send")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-canvas shadow-sm transition-[transform,opacity,background-color] hover:-translate-y-0.5 hover:bg-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowUp className="h-4 w-4 stroke-[2.4]" aria-hidden />
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
