import { useEffect, useRef, useState } from "react";
import {
  ArrowUpCircle,
  ChevronDown,
  HelpCircle,
  Loader2,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { formatRelativeTime } from "../../lib/utils";
import { providerMeta } from "../../lib/provider-catalog";
import type {
  ProviderDetectionStatus,
  ProviderInstallation,
} from "../../lib/types";
import { Tooltip } from "../../components/ui/Tooltip";

import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { useAgentsStore } from "../../stores/agents";
import { toast } from "../../stores/toast";

/** Self-update subcommand each bundled CLI exposes; custom CLIs have none. */
const PROVIDER_UPDATE_ARGS: Partial<Record<string, string[]>> = {
  codex: ["update"],
  "kimi-code": ["update"],
  "claude-code": ["update"],
  opencode: ["upgrade"],
};

function ProviderCard({
  installation,
}: {
  installation: ProviderInstallation;
}): JSX.Element {
  const { t, locale } = useI18n();
  const redetect = useAgentsStore((state) => state.redetect);
  const detecting = useAgentsStore(
    (state) => !!state.detecting[installation.providerId],
  );
  const meta = providerMeta(installation.providerId);
  const updateArgs = PROVIDER_UPDATE_ARGS[installation.providerId];
  const [expanded, setExpanded] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateState, setUpdateState] = useState<"running" | "done" | "failed">(
    "running",
  );
  const [updateOutput, setUpdateOutput] = useState("");
  const [updateExitCode, setUpdateExitCode] = useState<number | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const updateIdRef = useRef("");

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [updateOutput]);

  const handleRedetect = async (): Promise<void> => {
    try {
      await redetect(installation.providerId);
      toast.success(t("agents.providers.redetectDone", { name: meta.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleUpdate = async (): Promise<void> => {
    const bridge = window.agenthub;
    if (!bridge || !updateArgs || !installation.executable) return;
    const updateId = crypto.randomUUID();
    updateIdRef.current = updateId;
    setUpdateOutput("");
    setUpdateExitCode(null);
    setUpdateState("running");
    setUpdateOpen(true);
    const offOutput = bridge.providers.onUpdateOutput((id, chunk) => {
      if (id === updateId) setUpdateOutput((previous) => previous + chunk);
    });
    const offExit = bridge.providers.onUpdateExit((id, exitCode, error) => {
      if (id !== updateId) return;
      offOutput();
      offExit();
      setUpdateExitCode(exitCode);
      setUpdateState(exitCode === 0 ? "done" : "failed");
      if (error)
        setUpdateOutput(
          (previous) => `${previous}${previous ? "\n" : ""}${error}`,
        );
      if (exitCode === 0) {
        toast.success(t("agents.providers.updateDone", { name: meta.name }));
        void redetect(installation.providerId);
      }
    });
    try {
      const started = await bridge.providers.startUpdate({
        updateId,
        executable: installation.executable,
        args: updateArgs,
      });
      if (!started.ok) {
        offOutput();
        offExit();
        setUpdateState("failed");
        setUpdateOutput(
          t("agents.providers.updateStartFailed", { reason: started.reason }),
        );
      }
    } catch (error) {
      offOutput();
      offExit();
      setUpdateState("failed");
      setUpdateOutput(error instanceof Error ? error.message : String(error));
    }
  };

  const handleUpdateOpenChange = (open: boolean): void => {
    if (!open && updateState === "running")
      void window.agenthub?.providers.cancelUpdate(updateIdRef.current);
    setUpdateOpen(open);
  };

  const hintKey: Partial<Record<ProviderDetectionStatus, MessageKey>> = {
    missing: "agents.providers.missingHint",
    outdated: "agents.providers.outdatedHint",
    error: "agents.providers.errorHint",
  };

  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex min-h-[76px] flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
        <div className="min-w-32 flex-1">
          <h3 className="text-sm font-medium text-ink">{meta.name}</h3>
        </div>
        <span
          className="min-w-32 flex-[2] truncate font-mono text-[13px] text-ink-2"
          title={installation.executable}
        >
          {installation.executable ?? "—"}
        </span>
        <span className="flex min-w-20 items-center gap-2 text-[13px] text-ink-2">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${installation.status === "ready" ? "bg-ok" : installation.status === "error" ? "bg-danger" : "bg-warn"}`}
          />
          {t(`status.provider.${installation.status}`)}
        </span>
        {updateArgs &&
          installation.executable &&
          installation.status !== "missing" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleUpdate()}
              disabled={detecting || (updateOpen && updateState === "running")}
            >
              <ArrowUpCircle className="h-3.5 w-3.5" aria-hidden />
              {t("agents.providers.update")}
            </Button>
          )}
        <Tooltip content={t("agents.providers.redetect")}>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void handleRedetect()}
            disabled={detecting}
            aria-label={`${t("agents.providers.redetect")} ${meta.name}`}
          >
            <RefreshCw
              className={`h-4 w-4 ${detecting ? "animate-spin" : ""}`}
              aria-hidden
            />
          </Button>
        </Tooltip>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls={`cli-details-${installation.providerId}`}
          aria-label={locale === "zh-CN" ? "详情" : "Details"}
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
            aria-hidden
          />
        </Button>
      </div>
      {expanded && (
        <dl
          id={`cli-details-${installation.providerId}`}
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 border-t border-line bg-panel/40 px-5 py-5 text-[13px]"
        >
          <dt className="text-ink-3">{t("agents.providers.version")}</dt>
          <dd className="text-ink-2">
            {installation.version ?? "—"}
            {installation.status === "outdated" && meta.minVersion && (
              <span className="ml-2 text-warn">
                {t("agents.providers.minVersion", { version: meta.minVersion })}
              </span>
            )}
          </dd>
          <dt className="text-ink-3">{t("agents.providers.capabilities")}</dt>
          <dd className="text-ink-2">
            {meta.capabilities
              .map((capability) =>
                t(`capabilities.${capability}` as MessageKey),
              )
              .join(" · ")}
          </dd>
          <dt className="text-ink-3">{meta.vendor}</dt>
          <dd className="text-ink-3">
            {t("agents.providers.checkedAt", {
              time: formatRelativeTime(installation.checkedAt, locale),
            })}
          </dd>
          {hintKey[installation.status] && (
            <dd className="col-span-2 text-ink-2">
              {t(hintKey[installation.status]!)}
            </dd>
          )}
        </dl>
      )}

      <Dialog
        open={updateOpen}
        onOpenChange={handleUpdateOpenChange}
        title={t("agents.providers.updateTitle", { name: meta.name })}
        description={t("agents.providers.updateDesc", {
          command: `${installation.executable} ${(updateArgs ?? []).join(" ")}`,
        })}
        footer={
          updateState === "running" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void window.agenthub?.providers.cancelUpdate(
                  updateIdRef.current,
                )
              }
            >
              {t("agents.providers.updateCancel")}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setUpdateOpen(false)}
            >
              {t("common.close")}
            </Button>
          )
        }
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            {updateState === "running" && (
              <>
                <Loader2
                  className="h-4 w-4 animate-spin text-info"
                  aria-hidden
                />
                <span className="text-ink-2">
                  {t("agents.providers.updating")}
                </span>
              </>
            )}
            {updateState === "done" && (
              <span className="text-ok">
                {t("agents.providers.updateDone", { name: meta.name })}
              </span>
            )}
            {updateState === "failed" && (
              <span className="text-danger">
                {t("agents.providers.updateFailed", {
                  code: updateExitCode ?? -1,
                })}
              </span>
            )}
          </div>
          <pre
            ref={outputRef}
            className="max-h-80 overflow-auto rounded-lg border border-line bg-panel/40 p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-ink-2"
          >
            {updateOutput || t("agents.providers.updateEmptyOutput")}
          </pre>
        </div>
      </Dialog>
    </li>
  );
}

export function ProvidersPanel(): JSX.Element {
  const { t } = useI18n();
  const installations = useAgentsStore((state) => state.installations);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-sm font-medium text-ink">
        CLI
        <Tooltip content={t("agents.providers.notice")}>
          <button
            type="button"
            aria-label={t("agents.providers.notice")}
            className="rounded text-ink-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <HelpCircle className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>
      <ul className="overflow-hidden rounded-lg border border-line">
        {installations.map((installation) => (
          <ProviderCard
            key={installation.providerId}
            installation={installation}
          />
        ))}
      </ul>
      {installations.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-3">
          <Terminal className="h-4 w-4" aria-hidden />
          {t("common.none")}
        </div>
      )}
    </div>
  );
}
