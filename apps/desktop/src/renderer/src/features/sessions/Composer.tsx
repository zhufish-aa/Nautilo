import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { AnimatePresence } from "framer-motion";
import type { SlashCommandDefinition } from "@agenthub/domain";
import { ArrowUp, Square } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { sendWorkbenchMessage, stopWorkbenchRun } from "../../lib/orchestration-runtime";
import { SessionModelControl } from "./SessionModelControl";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { CommandResultDialog } from "./slash-commands/CommandResultDialog";
import { SlashCommandMenu } from "./slash-commands/SlashCommandMenu";
import { filterSlashCommands, parseSlashCommand, slashCommandQuery } from "./slash-commands/slash-command-utils";
import { useSlashCommands } from "./slash-commands/useSlashCommands";

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
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const slash = useSlashCommands(sessionId);
  const commandQuery = slashCommandQuery(value);
  const filteredCommands = useMemo(
    () => commandQuery ? filterSlashCommands(slash.commands, commandQuery) : [],
    [commandQuery, slash.commands]
  );
  const commandMenuOpen = commandQuery !== undefined && slash.commands.length > 0;

  useEffect(() => setActiveCommandIndex(0), [commandQuery, sessionId]);

  const canSend = !!sessionId && !running && value.trim().length > 0 && !disabled;

  const runCommand = (command: SlashCommandDefinition, argument?: string): void => {
    if (!sessionId) return;
    if (command.argumentRequired && !argument) {
      setValue(`${command.name} `);
      return;
    }
    void slash.execute(command, argument);
    setValue("");
  };
  const submit = (): void => {
    if (!sessionId) return;
    const parsed = parseSlashCommand(value, slash.commands);
    if (parsed && (parsed.command.availability === "always" || !running)) {
      runCommand(parsed.command, parsed.argument);
      return;
    }
    if (!canSend) return;
    void sendWorkbenchMessage(sessionId, value.trim());
    setValue("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
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
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <div className="border-t border-line/70 bg-panel/95 px-5 pb-4 pt-3 backdrop-blur-xl">
      <div className="relative mx-auto w-full max-w-4xl rounded-[22px] border border-line-strong bg-card shadow-[0_12px_36px_-24px_rgba(15,23,42,0.42)] transition-[border-color,box-shadow] focus-within:border-accent/45 focus-within:shadow-[0_16px_44px_-24px_rgba(99,102,241,0.42)]">
        <AnimatePresence>
          {commandMenuOpen && (
            <SlashCommandMenu
              commands={filteredCommands}
              activeIndex={activeCommandIndex}
              onActiveIndexChange={setActiveCommandIndex}
              onSelect={runCommand}
            />
          )}
        </AnimatePresence>
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          disabled={!sessionId || disabled}
          placeholder={t("sessions.composer.placeholder", { name: targetName ?? "Agent" })}
          aria-label={t("sessions.composer.placeholder", { name: targetName ?? "Agent" })}
          className="block max-h-48 min-h-[58px] w-full resize-none rounded-t-[22px] bg-transparent px-4 pb-1.5 pt-3.5 text-sm leading-6 text-ink outline-none placeholder:text-ink-3/65 disabled:opacity-50"
        />
        <div className="flex min-h-11 items-center gap-3 px-3 pb-2.5">
          <p className="min-w-0 flex-1 truncate px-1 text-[11px] text-ink-3">{t("sessions.composer.hint")}</p>
          <SessionModelControl sessionId={sessionId} disabled={running || disabled} />
          <ContextUsageIndicator sessionId={sessionId} />
          {running ? (
            <button
              type="button"
              onClick={() => sessionId && void stopWorkbenchRun(sessionId)}
              aria-label={t("sessions.composer.stop")}
              title={t("sessions.composer.stop")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-danger/35 bg-danger/10 text-danger transition-colors hover:bg-danger/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/35"
            >
              <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
            </button>
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
