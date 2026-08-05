import { useCallback, useEffect, useState } from "react";
import type { SlashCommandDefinition, SlashCommandResult } from "@agenthub/domain";
import { requestCore } from "../../../lib/bridge";
import { useProvidersStore } from "../../../stores/providers";
import { useSessionsStore } from "../../../stores/sessions";

export function useSlashCommands(sessionId?: string): {
  commands: SlashCommandDefinition[];
  result?: SlashCommandResult;
  loading: boolean;
  error?: string;
  execute(command: SlashCommandDefinition, argument?: string): Promise<boolean>;
  continueCommand(actionId: string, selectedOptionIds: string[]): Promise<void>;
  closeResult(): void;
} {
  const [commands, setCommands] = useState<SlashCommandDefinition[]>([]);
  const [result, setResult] = useState<SlashCommandResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const providerCatalog = useProvidersStore((state) => state.catalog);
  const providerCommandRevision = useSessionsStore((state) =>
    sessionId ? state.providerCommandRevisions[sessionId] ?? 0 : 0
  );

  useEffect(() => {
    let active = true;
    setCommands([]);
    setResult(undefined);
    setError(undefined);
    if (!sessionId) return () => { active = false; };
    void requestCore<SlashCommandDefinition[]>("slashCommand.list", { sessionId })
      .then((items) => { if (active) setCommands(items); })
      .catch((cause) => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [sessionId, providerCatalog, providerCommandRevision]);

  const applyPatch = useCallback((next: SlashCommandResult): void => {
    if (!sessionId || !next.sessionPatch) return;
    useSessionsStore.getState()._configureSession(sessionId, next.sessionPatch);
  }, [sessionId]);

  const execute = useCallback(async (command: SlashCommandDefinition, argument?: string): Promise<boolean> => {
    if (!sessionId) return false;
    setLoading(true);
    setError(undefined);
    try {
      const next = await requestCore<SlashCommandResult>("slashCommand.execute", { sessionId, commandId: command.id, argument });
      applyPatch(next);
      setResult(next);
      return true;
    } catch (cause) {
      setError(message(cause));
      setResult({
        commandId: command.id,
        title: "指令执行失败",
        sections: [{ kind: "text", text: message(cause) }],
        actions: [{ id: "close", label: "关闭", kind: "primary" }],
        completed: true
      });
      return false;
    } finally {
      setLoading(false);
    }
  }, [applyPatch, sessionId]);

  const continueCommand = useCallback(async (actionId: string, selectedOptionIds: string[]): Promise<void> => {
    if (!sessionId || !result) return;
    if (actionId === "close") {
      setResult(undefined);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const next = await requestCore<SlashCommandResult>("slashCommand.continue", {
        sessionId,
        commandId: result.commandId,
        actionId,
        selectedOptionIds
      });
      applyPatch(next);
      setResult(next);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [applyPatch, result, sessionId]);

  return {
    commands,
    result,
    loading,
    error,
    execute,
    continueCommand,
    closeResult: () => setResult(undefined)
  };
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
