import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { createPortal } from "react-dom";
import type { SlashCommandDefinition, WorkflowTemplate } from "@agenthub/domain";
import { ArrowUp, Bug, Check, FileText, FolderTree, GitPullRequest, Lightbulb, Loader2, Paperclip, Plus, Square, Target, Workflow, X } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { configureWorkbenchSession, sendWorkbenchFollowUp, sendWorkbenchMessage, stopWorkbenchRun } from "../../lib/orchestration-runtime";
import { getBridge } from "../../lib/bridge";
import { useCoreFeatures } from "../../lib/use-core-features";
import { retryComposerDraftSave, startComposerPersistence } from "../../lib/composer-persistence";
import { connectionSendError } from "../../lib/session-connections";
import { artifactUrlForPath } from "../timeline/media-actions";
import type { DesktopAttachment } from "../../types/bridge";
import { deliverComposerSubmission, EMPTY_COMPOSER_DRAFT, useComposerDraftsStore, type ComposerSubmission } from "../../stores/composer-drafts";
import { useSessionsStore } from "../../stores/sessions";
import { useAgentsStore } from "../../stores/agents";
import { useProvidersStore } from "../../stores/providers";
import { useTeamsStore } from "../../stores/teams";
import { permissionModesFor } from "../../lib/provider-catalog";
import { useSettingsStore } from "../../stores/settings";
import { useWorkflowsStore } from "../../stores/workflows";
import { filterSnippets, snippetQuery } from "../../lib/snippets";
import { toast } from "../../stores/toast";
import { PermissionModeSelect, SessionPermissionControl } from "./PermissionModeSelect";
import { SessionModelControl } from "./SessionModelControl";
import { ContextUsageIndicator, useContextUsage } from "./ContextUsageIndicator";
import { CommandResultDialog } from "./slash-commands/CommandResultDialog";
import { SlashCommandMenu } from "./slash-commands/SlashCommandMenu";
import { SnippetMenu } from "./slash-commands/SnippetMenu";
import { filterSlashCommands, parseSlashCommand, slashCommandQuery } from "./slash-commands/slash-command-utils";
import { useSlashCommands } from "./slash-commands/useSlashCommands";
import { QueuedFollowUpBar } from "./QueuedFollowUpBar";
import { SessionHarnessModeControl } from "./HarnessModeControl";
import { WorkflowMentionMenu, workflowQueryAt, type WorkflowQuery } from "./WorkflowMentionMenu";
import { flashComposer } from "./composer-motion";
import "./composer-motion.css";
import "./workflow-plan.css";

const starterPrompts = [
  { icon: Bug, zh: "排查问题并补测试", en: "Debug and add tests", promptZh: "排查问题的根因，修复后补上回归测试。", promptEn: "Find the root cause, fix it, and add a regression test." },
  { icon: GitPullRequest, zh: "审查当前改动", en: "Review current changes", promptZh: "审查当前改动，指出具体问题和回归风险。", promptEn: "Review the current changes for concrete issues and regression risks." },
  { icon: FolderTree, zh: "梳理项目结构", en: "Map the project", promptZh: "梳理项目结构，找出主要入口和核心模块。", promptEn: "Map the project structure and identify the main entry points and core modules." }
] as const;

/** Chat composer plus per-session model/effort controls, matching the Codex interaction model. */
export function Composer({
  sessionId,
  targetName,
  running,
  disabled,
  submissionDisabledReason,
  onCreateSession,
  starterControls,
  contextControls,
  trailingControls,
  draftId,
  compactTarget
}: {
  sessionId?: string;
  targetName?: string;
  running: boolean;
  disabled?: boolean;
  /** Configuration can block sending while the user continues writing a draft. */
  submissionDisabledReason?: string;
  /** The landing creates a real session only when its first message is sent. */
  onCreateSession?: (text: string) => string | undefined;
  starterControls?: ComponentProps<typeof SessionModelControl>["draft"];
  contextControls?: ReactNode;
  trailingControls?: ReactNode;
  /** Distinguishes independent new Code and Work drafts. */
  draftId?: string;
  compactTarget?: HTMLSpanElement | null;
}): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const draftKey = sessionId ?? draftId ?? "new";
  const draft = useComposerDraftsStore((state) => state.drafts[draftKey] ?? EMPTY_COMPOSER_DRAFT);
  const session = useSessionsStore(state => state.sessions.find(item => item.id === sessionId));
  const target = session?.target;
  const memberId = useTeamsStore(state => target?.type === "member"
    ? state.teams.find(team => team.id === target.teamId)?.members.find(member => member.id === target.memberId)?.agentInstanceId
    : undefined);
  const instanceId = starterControls?.instanceId ?? (target?.type === "agent" ? target.instanceId : memberId);
  const instance = useAgentsStore(state => state.instances.find(item => item.id === instanceId));
  useProvidersStore(state => state.catalog);
  const permissionModes = instance ? permissionModesFor(instance.providerId) : [];
  const codex = instance?.providerId === "codex" && !instance.baseArgs?.length;
  const supportsPlan = codex || permissionModes.some(mode => mode.value === "plan");
  const goalSelected = codex && draft.text.startsWith("/goal ");
  const agentMode = starterControls?.configuration.agentMode ?? session?.agentMode;
  const defaultPermissionMode = permissionModes.some(mode => mode.value === "inherit") ? "inherit" : "default";
  const permissionMode = starterControls?.configuration.permissionMode ?? session?.permissionMode ?? instance?.permissionMode ?? defaultPermissionMode;
  const planSelected = supportsPlan && (agentMode === "plan" || permissionMode === "plan");
  const value = goalSelected ? draft.text.slice(6) : draft.text;
  const attachments = draft.attachments;
  const updateText = useComposerDraftsStore((state) => state.setText);
  const updateAttachments = useComposerDraftsStore((state) => state.setAttachments);
  const updateWorkflow = useComposerDraftsStore((state) => state.setWorkflow);
  const submitting = useComposerDraftsStore((state) => !!state.pending[draftKey]);
  const failedSubmissions = useComposerDraftsStore((state) => state.failed[draftKey]);
  const persistenceError = useComposerDraftsStore((state) => state.persistenceErrors[draftKey]);
  useEffect(() => { void startComposerPersistence().catch(error => {
    useComposerDraftsStore.setState(state => ({ persistenceErrors: { ...state.persistenceErrors, [draftKey]: String(error) } }));
  }); }, [draftKey]);
  const setValue = (text: string): void => updateText(draftKey, goalSelected && !text.startsWith("/goal ") ? `/goal ${text}` : text);
  const setAttachments = (next: DesktopAttachment[] | ((current: DesktopAttachment[]) => DesktopAttachment[])): void => updateAttachments(draftKey, next);
  const [importing, setImporting] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useUiReducedMotion();
  const workflowPlans = useCoreFeatures().workflowPlans === 1;
  const canReference = workflowPlans && !goalSelected && !disabled && !session?.parentSessionId && session?.target.type !== "team";
  const showStarter = !sessionId && !!onCreateSession;
  const [mention, setMention] = useState<WorkflowQuery>();
  const [workflowIndex, setWorkflowIndex] = useState(0);
  const [workflowError, setWorkflowError] = useState(false);
  const workflowMenuId = useId();
  const templates = useWorkflowsStore(state => state.templates);
  const templatesLoaded = useWorkflowsStore(state => state.loaded);
  const starterWorkflows = showStarter && canReference ? templates.slice(0, 3) : [];
  const mentionOpen = canReference && mention !== undefined;
  const matchingWorkflows = useMemo(() => mention
    ? templates.filter(template => template.name.toLowerCase().includes(mention.text)).slice(0, 40)
    : [], [templates, mention?.text]);
  useEffect(() => { setWorkflowIndex(0); }, [mention?.text, draftKey]);
  useEffect(() => { setMention(undefined); }, [draftKey]);
  useEffect(() => {
    if (!mentionOpen && !(showStarter && canReference && !useWorkflowsStore.getState().loaded)) return;
    let current = true;
    setWorkflowError(false);
    void useWorkflowsStore.getState().loadTemplates().catch(() => { if (current) setWorkflowError(true); });
    return () => { current = false; };
  }, [mentionOpen, showStarter, canReference]);
  function focusDraft(caret: number): void {
    textareaRef.current?.focus();
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(caret, caret));
  }
  function selectWorkflow(template: WorkflowTemplate, fromShortcut = false): void {
    if (mention) setValue(value.slice(0, mention.start) + value.slice(mention.end));
    updateWorkflow(draftKey, { id: template.id, revision: template.revision, name: template.name });
    setMention(undefined);
    focusDraft(mention?.start ?? value.length);
    if (fromShortcut && !reducedMotion) flashComposer(boxRef.current);
  }
  const editingMessage = useSessionsStore((state) => state.editingMessage?.sessionId === sessionId ? state.editingMessage : undefined);
  const cancelEditingMessage = useSessionsStore((state) => state.cancelEditingMessage);
  const nextTurnModel = useSessionsStore(state => sessionId ? state.nextTurnModels[sessionId] : undefined);
  const hasQueuedFollowUps = useSessionsStore(state => !!(sessionId && state.queuedFollowUps[sessionId]?.length));
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const slash = useSlashCommands(sessionId);
  const promptSnippets = useSettingsStore((state) => state.promptSnippets);
  const snippetQ = snippetQuery(value);
  const filteredSnippets = useMemo(
    () => snippetQ !== undefined ? filterSnippets(promptSnippets, snippetQ) : [],
    [snippetQ, promptSnippets]
  );
  const snippetMenuOpen = !mentionOpen && snippetQ !== undefined && filteredSnippets.length > 0;
  const commandQuery = goalSelected || snippetQ !== undefined ? undefined : slashCommandQuery(value);
  const filteredCommands = useMemo(
    () => commandQuery ? filterSlashCommands(slash.commands, commandQuery) : [],
    [commandQuery, slash.commands]
  );
  const commandMenuOpen = !mentionOpen && commandQuery !== undefined && slash.commands.length > 0;
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
    updateText(draftKey, editingMessage.text);
    updateWorkflow(draftKey, editingMessage.workflowRef);
    focusDraft(editingMessage.text.length);
  }, [editingMessage]);
  // Queued follow-ups live in the sessions store (daemon queue + events).

  const canCompose = !!sessionId || !!onCreateSession;
  const waitsForNextTurn = !!nextTurnModel && (running || hasQueuedFollowUps);
  const canSend = canCompose && !submitting && !running && !waitsForNextTurn && !importing && (goalSelected ? !!value.trim() && !planSelected : value.trim().length > 0 || attachments.length > 0 || !!draft.workflow) && !disabled && !submissionDisabledReason && (!draft.workflow || canReference);
  const canFollowUp = !!sessionId && !goalSelected && !submitting && running && !waitsForNextTurn && !importing && !disabled && !editingMessage && !draft.workflow && attachments.length === 0 && value.trim().length > 0;
  const actionsDisabled = !canCompose || disabled || importing || running;
  const planDisabled = actionsDisabled || submitting || hasQueuedFollowUps || goalSelected;
  const toggleGoal = (): void => {
    updateText(draftKey, goalSelected ? value : `/goal ${value}`);
    requestAnimationFrame(() => focusDraft(value.length));
  };
  const togglePlan = (): void => {
    const patch = {
      agentMode: planSelected ? "default" : "plan",
      ...(planSelected && permissionMode === "plan" ? { permissionMode: permissionModes.find(option => option.value === "default")?.value ?? permissionModes.find(option => option.value !== "plan")?.value ?? "default" } : {})
    };
    if (sessionId) void configureWorkbenchSession(sessionId, patch).catch(error => toast.error(String(error)));
    else starterControls?.onChange(patch);
  };

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
    const parsed = !goalSelected && attachments.length === 0 && !draft.workflow ? parseSlashCommand(value, slash.commands) : undefined;
    if (parsed && (parsed.command.availability === "always" || !running)) {
      runCommand(parsed.command, parsed.argument);
      return true;
    }
    return false;
  };
  const dispatchSubmission = (kind: ComposerSubmission["kind"], retryToken?: number): void => {
    if (disabled || submissionDisabledReason || waitsForNextTurn) return;
    const store = useComposerDraftsStore.getState();
    let submission = store.begin(draftKey, kind, editingMessage?.messageId, retryToken);
    if (!submission) return; // Atomic across double-clicks and mounted composers.
    if (submission.draft.workflow && !canReference) {
      store.finish(submission, locale === "zh-CN" ? "当前会话暂时无法引用工作流" : "Workflow references are unavailable in this conversation");
      return;
    }
    if (submission.kind !== "message" && !running) submission = { ...submission, kind: "message" };
    try {
      const title = submission.draft.text.trim();
      const destinationId = sessionId ?? onCreateSession?.(codex ? title.replace(/^\/goal\s+/, "") : title);
      if (!destinationId) throw new Error(locale === "zh-CN" ? "未能创建会话，内容已保留" : "Could not create the conversation. Your draft is retained.");
      if (sessionId && !reducedMotion) flashComposer(boxRef.current, true);
      submission = store.move(submission, destinationId);
      const sent = submission;
      void deliverComposerSubmission(sent, async () => {
        const text = sent.draft.text.trim() || (sent.draft.workflow
          ? (locale === "zh-CN" ? "请为这次任务拟一份工作流执行计划。" : "Prepare a plan using the referenced workflow.")
          : t("sessions.composer.attachmentPrompt"));
        if (sent.kind === "message") {
          await sendWorkbenchMessage(destinationId, text, sent.draft.attachments, sent.editMessageId, sent.messageId, sent.draft.workflow);
          // Do not cancel a different edit the user began while awaiting IPC.
          const currentEdit = useSessionsStore.getState().editingMessage;
          if (sent.editMessageId && currentEdit?.sessionId === destinationId && currentEdit.messageId === sent.editMessageId && useComposerDraftsStore.getState().drafts[destinationId] === sent.draft) cancelEditingMessage();
        } else {
          const appliedMode = await sendWorkbenchFollowUp(destinationId, text, sent.kind, sent.messageId);
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
    if (mentionOpen) {
      if (event.key === "Escape") { event.preventDefault(); setMention(undefined); return; }
      if (matchingWorkflows.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        const total = matchingWorkflows.length;
        setWorkflowIndex(index => (index + (event.key === "ArrowDown" ? 1 : -1) + total) % total);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && matchingWorkflows[workflowIndex]) {
        event.preventDefault();
        selectWorkflow(matchingWorkflows[workflowIndex]);
        return;
      }
    }
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
      <div ref={boxRef} className="composer-box relative mx-auto w-full">
        <div className="composer-pulse" aria-hidden="true" />
        {contextControls}
        {mentionOpen && <WorkflowMentionMenu id={workflowMenuId} templates={matchingWorkflows} active={workflowIndex}
          loaded={templatesLoaded} error={workflowError} onSelect={selectWorkflow} onHighlight={setWorkflowIndex} zh={locale === "zh-CN"} />}
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
        {draft.workflow && <div className="workflow-composer-reference">
          <span className="workflow-reference-chip"><Workflow size={14} aria-hidden /><span>{draft.workflow.name}</span>
            <button type="button" onClick={() => updateWorkflow(draftKey)} aria-label={locale === "zh-CN" ? "移除工作流引用" : "Remove workflow reference"}><X size={13}/></button>
          </span>
        </div>}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={event => {
            setValue(event.target.value);
            if (canReference) setMention(workflowQueryAt(event.target.value, event.target.selectionStart));
          }}
          onClick={event => { if (canReference) setMention(workflowQueryAt(event.currentTarget.value, event.currentTarget.selectionStart)); }}
          onBlur={() => setMention(undefined)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={2}
          disabled={!canCompose || disabled}
          aria-controls={mentionOpen ? workflowMenuId : undefined}
          aria-activedescendant={mentionOpen && matchingWorkflows[workflowIndex] ? workflowMenuId + "-" + workflowIndex : undefined}
          placeholder={goalSelected ? (zh ? "写下要达成的目标和验收条件" : "Describe the goal and how to verify it") : zh ? (canReference ? "输入任务，或用 @ 引用已保存的工作流" : "今天帮你做些什么？输入任务，或添加文件") : (canReference ? "Describe a task, or type @ to reference a workflow" : "What can I help with? Describe a task, or add files")}
          aria-label={t("sessions.composer.placeholder", { name: targetName ?? "Agent" })}
          className="block max-h-48 min-h-[76px] w-full resize-none rounded-t-2xl bg-transparent px-4 pb-2 pt-4 text-[14px] leading-6 text-ink outline-none placeholder:text-ink-3/70 disabled:opacity-50"
        />
        {failedSubmissions?.map((failedSubmission) => <div key={failedSubmission.submission.token} role="alert" className="flex flex-wrap items-center gap-2 px-4 pb-2 text-xs text-danger">
          <span className="min-w-0 flex-1" title={failedSubmission.submission.draft.text}>{connectionSendError(failedSubmission.error, locale === "zh-CN")} · {failedSubmission.submission.draft.text.slice(0, 48) || (locale === "zh-CN" ? "附件" : "Attachments")}</span>
          <button type="button" disabled={submitting || disabled || !!submissionDisabledReason || waitsForNextTurn || (failedSubmission.submission.kind === "message" && running)} onClick={() => dispatchSubmission(failedSubmission.submission.kind, failedSubmission.submission.token)} className="rounded px-2 py-1 text-ink-2 underline disabled:opacity-40">{failedSubmission.submission.kind !== "message" && !running ? (locale === "zh-CN" ? "作为新消息重试" : "Retry as new message") : (locale === "zh-CN" ? "重试未发送内容" : "Retry unsent content")}</button>
        </div>)}
        {persistenceError && <div role="alert" className="flex flex-wrap items-center gap-2 px-4 pb-2 text-xs text-ink">
          <span className="min-w-0 flex-1" title={persistenceError}>{locale === "zh-CN" ? "草稿尚未保存，本窗口内容已保留" : "Draft not saved. Your input is retained in this window."}</span>
          <button type="button" className="rounded px-2 py-1 font-medium underline" onClick={() => void retryComposerDraftSave(draftKey).catch(error => toast.error(String(error)))}>{locale === "zh-CN" ? "保存本窗口" : "Save local draft"}</button>
          <button type="button" className="rounded px-2 py-1 font-medium underline" onClick={() => void retryComposerDraftSave(draftKey, false).catch(error => toast.error(String(error)))}>{locale === "zh-CN" ? "载入已保存草稿" : "Load saved draft"}</button>
        </div>}
        {attachmentError && <p className="px-4 pb-1 text-[11px] text-danger">{attachmentError}</p>}
        <div className="composer-toolbar flex min-h-11 flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
          <Menu.Root modal={false}>
            <Menu.Trigger type="button" disabled={actionsDisabled} className="composer-attach composer-add-trigger flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-card-hover hover:text-ink disabled:opacity-40" aria-label={zh ? "添加" : "Add"} title={zh ? "添加" : "Add"}>
              {importing ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Plus size={18} className="composer-plus-icon" aria-hidden />}
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content className="composer-add-menu" side="top" align="start" sideOffset={8} collisionPadding={12} aria-label={zh ? "输入框操作" : "Composer actions"}>
                <Menu.Item className="composer-add-item" onSelect={() => void pickFiles()}><Paperclip size={16} aria-hidden /><span>{t("sessions.composer.addAttachment")}</span></Menu.Item>
                {codex && <Menu.CheckboxItem className="composer-add-item" checked={goalSelected} disabled={planSelected || !!draft.workflow || !!editingMessage || submitting} onCheckedChange={toggleGoal}>
                  <Target size={16} aria-hidden /><span>{zh ? "目标" : "Goal"}</span><small>{zh ? "设定持续追踪的目标" : "Work toward a persistent objective"}</small><Menu.ItemIndicator><Check size={14} aria-hidden /></Menu.ItemIndicator>
                </Menu.CheckboxItem>}
                {supportsPlan && <Menu.CheckboxItem className="composer-add-item" checked={planSelected} disabled={planDisabled} onCheckedChange={togglePlan}>
                  <Lightbulb size={16} aria-hidden /><span>{t("sessions.composer.planMode")}</span><small>{zh ? "先调研和拟定方案" : "Explore and draft a plan first"}</small><Menu.ItemIndicator><Check size={14} aria-hidden /></Menu.ItemIndicator>
                </Menu.CheckboxItem>}
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
          {sessionId ? <SessionPermissionControl sessionId={sessionId} disabled={running || disabled} /> : starterControls && <PermissionModeSelect value={permissionMode} options={permissionModes} onChange={permissionMode => starterControls.onChange({ permissionMode })} />}
          {(goalSelected || planSelected) && <button type="button" className="composer-mode-label" disabled={goalSelected ? actionsDisabled : planDisabled}
            aria-label={goalSelected ? (zh ? "取消目标" : "Clear goal draft") : t("sessions.composer.planModeDisable")}
            onClick={goalSelected ? toggleGoal : togglePlan}>
            {goalSelected ? <Target size={15} aria-hidden /> : <Lightbulb size={15} aria-hidden />}{goalSelected ? (zh ? "目标" : "Goal") : (zh ? "计划" : "Plan")}
          </button>}
          {sessionId && <SessionHarnessModeControl sessionId={sessionId} disabled={running || disabled} />}
          <span className="min-w-0 flex-1" />
          {sessionId ? <SessionModelControl sessionId={sessionId} running={running || hasQueuedFollowUps} disabled={disabled || submitting} /> : starterControls ? <SessionModelControl draft={starterControls} /> : trailingControls}
          {compactTarget && compactCommand && createPortal(<button type="button" className="session-inspector-compact"
            disabled={disabled || running || slash.loading} onClick={runCompact}>
            {t(slash.loading ? "sessions.composer.compacting" : "sessions.composer.compact")}
          </button>, compactTarget)}
          <ContextUsageIndicator
            sessionId={sessionId}
            compactCommand={compactCommand}
            onCompact={runCompact}
            compactDisabled={!sessionId || disabled || running || slash.loading}
            compactLoading={slash.loading}
          />
          <div className="composer-actions">
            {(!running || (!submitting && (value.trim().length > 0 || attachments.length > 0))) && (
              <button
                type="button"
                onClick={submit}
                disabled={running ? !canFollowUp : !canSend}
                aria-label={t(running && !waitsForNextTurn ? "sessions.composer.steer" : "sessions.composer.send")}
                title={waitsForNextTurn
                  ? (locale === "zh-CN" ? "本轮结束后，下一条使用所选模型" : "Send with the selected model after the current turn")
                  : submissionDisabledReason ?? t(running ? "sessions.composer.runningHint" : "sessions.composer.send")}
                className="composer-send"
              >
                {submitting ? <Loader2 size={16} className="composer-pending-icon" aria-hidden /> : <ArrowUp size={16} strokeWidth={2.4} className="composer-send-icon" aria-hidden />}
              </button>
            )}
            {running && (
              <button
                type="button"
                onClick={() => sessionId && void stopWorkbenchRun(sessionId)}
                aria-label={t("sessions.composer.stop")}
                title={t("sessions.composer.stop")}
                className="composer-stop"
              >
                <svg className="composer-stop-arc" viewBox="0 0 32 32" aria-hidden="true">
                  <circle cx="16" cy="16" r="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="21 74" strokeLinecap="round" />
                </svg>
                <Square size={12} className="composer-stop-icon" fill="currentColor" aria-hidden />
              </button>
            )}
            <span className="composer-launch-arrow" aria-hidden="true"><ArrowUp size={16} strokeWidth={2.4} /></span>
          </div>
        </div>
      </div>
      {showStarter && <div className="starter-launch" role="group" aria-label={locale === "zh-CN" ? "快捷启动" : "Quick launch"}>
        {starterWorkflows.map(template => <button key={template.id} type="button" title={template.name}
          aria-pressed={draft.workflow?.id === template.id} disabled={submitting || disabled}
          onMouseDown={event => event.preventDefault()} onClick={() => selectWorkflow(template, true)}>
          <Workflow size={14} className="starter-workflow-icon" aria-hidden />
          <span className="starter-launch-name">@ {template.name}</span>
          <small>{template.definition.nodes.length}{locale === "zh-CN" ? " 节点" : template.definition.nodes.length === 1 ? " node" : " nodes"}</small>
        </button>)}
        {starterPrompts.slice(0, 3 - starterWorkflows.length).map(({ icon: Icon, zh, en, promptZh, promptEn }) => <button type="button" key={en}
          disabled={submitting || disabled} onClick={() => {
            const prompt = locale === "zh-CN" ? promptZh : promptEn;
            const next = value.trim() ? `${value.trimEnd()}\n\n${prompt}` : prompt;
            setValue(next);
            setMention(undefined);
            focusDraft(next.length);
            if (!reducedMotion) flashComposer(boxRef.current);
          }}>
          <Icon size={15} aria-hidden />
          <span className="starter-launch-name">{locale === "zh-CN" ? zh : en}</span>
        </button>)}
      </div>}
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
