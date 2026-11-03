import { useState } from "react";
import { Bot, ChevronDown, Pencil, Plus } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { formatRelativeTime } from "../../lib/utils";
import { providerMeta } from "../../lib/provider-catalog";
import type { AgentInstanceConfig } from "../../lib/types";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Switch } from "../../components/ui/Switch";
import { Tooltip } from "../../components/ui/Tooltip";
import { useAgentsStore } from "../../stores/agents";
import { toast } from "../../stores/toast";
import { AgentEditorDialog } from "./AgentEditorDialog";

function InstanceRow({
  instance,
  onEdit,
}: {
  instance: AgentInstanceConfig;
  onEdit: (instance: AgentInstanceConfig) => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const setInstanceEnabled = useAgentsStore(
    (state) => state.setInstanceEnabled,
  );
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const meta = providerMeta(instance.providerId);
  const toggle = async (enabled: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await setInstanceEnabled(instance.id, enabled);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex min-h-[72px] items-center gap-4 px-4 py-3 sm:px-5">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-ink">
            {instance.displayName}
          </h3>
          <p className="mt-1 text-[13px] text-ink-3 sm:hidden">{meta.name}</p>
        </div>
        <span className="hidden min-w-24 flex-1 text-sm text-ink-2 sm:block">
          {meta.name}
        </span>
        <Tooltip content={t(`status.agent.${instance.status}` as MessageKey)}>
          <span
            aria-label={t(`status.agent.${instance.status}` as MessageKey)}
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${instance.status === "error" ? "bg-danger" : instance.status === "waiting_approval" || instance.status === "waiting_input" ? "bg-warn" : instance.enabled ? "bg-ok" : "bg-ink-3/40"}`}
          />
        </Tooltip>
        <Switch
          checked={instance.enabled}
          disabled={busy}
          onCheckedChange={(checked) => void toggle(checked)}
          aria-label={`${instance.displayName}: ${instance.enabled ? t("common.enabled") : t("common.disabled")}`}
        />
        <Tooltip content={t("agents.instances.edit")}>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onEdit(instance)}
            aria-label={`${t("agents.instances.edit")} ${instance.displayName}`}
          >
            <Pencil className="h-4 w-4" aria-hidden />
          </Button>
        </Tooltip>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls={`agent-details-${instance.id}`}
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
          id={`agent-details-${instance.id}`}
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 border-t border-line bg-panel/40 px-5 py-5 text-[13px]"
        >
          <dt className="text-ink-3">CLI</dt>
          <dd className="break-all font-mono text-ink-2">
            {instance.executable}
          </dd>
          <dt className="text-ink-3">{t("agents.editor.basic.envPolicy")}</dt>
          <dd className="text-ink-2">
            {t(`envPolicies.${instance.envPolicyId}.name` as MessageKey)}
          </dd>
          {instance.credentialStored && (
            <>
              <dt className="text-ink-3">API Key</dt>
              <dd className="text-ink-2">{t("agents.instances.apiKeySet")}</dd>
            </>
          )}
          {instance.baseUrl && (
            <>
              <dt className="text-ink-3">Base URL</dt>
              <dd className="break-all text-ink-2">{instance.baseUrl}</dd>
            </>
          )}
          {instance.baseArgs.length > 0 && (
            <>
              <dt className="text-ink-3">{t("agents.instances.args")}</dt>
              <dd className="break-all font-mono text-ink-2">
                {instance.baseArgs.join(" ")}
              </dd>
            </>
          )}
          <dt className="text-ink-3">
            {t(`status.agent.${instance.status}` as MessageKey)}
          </dt>
          <dd className="text-ink-3">
            {t("agents.instances.updatedAt", {
              time: formatRelativeTime(instance.updatedAt, locale),
            })}
          </dd>
        </dl>
      )}
    </li>
  );
}

export function InstancesPanel(): JSX.Element {
  const { t } = useI18n();
  const instances = useAgentsStore((state) => state.instances);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AgentInstanceConfig>();
  const openCreate = (): void => {
    setEditing(undefined);
    setEditorOpen(true);
  };
  const openEdit = (instance: AgentInstanceConfig): void => {
    setEditing(instance);
    setEditorOpen(true);
  };
  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <Button variant="outline" onClick={openCreate}>
          <Plus className="h-4 w-4" aria-hidden />
          {t("agents.instances.new")}
        </Button>
      </div>
      {instances.length === 0 ? (
        <EmptyState
          icon={Bot}
          title={t("agents.instances.emptyTitle")}
          description=""
          action={
            <Button variant="outline" onClick={openCreate}>
              {t("agents.instances.emptyAction")}
            </Button>
          }
        />
      ) : (
        <ul className="overflow-hidden rounded-lg border border-line">
          {instances.map((instance) => (
            <InstanceRow
              key={instance.id}
              instance={instance}
              onEdit={openEdit}
            />
          ))}
        </ul>
      )}
      <AgentEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        instance={editing}
      />
    </div>
  );
}
