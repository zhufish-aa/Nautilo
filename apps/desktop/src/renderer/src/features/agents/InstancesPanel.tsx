import { useState } from "react";
import { Bot, Pencil, Plus } from "lucide-react";
import type { AgentStatus } from "@agenthub/domain";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { formatRelativeTime } from "../../lib/utils";
import { providerMeta } from "../../lib/provider-catalog";
import type { AgentInstanceConfig } from "../../lib/types";
import { MotionCard, StaggerGroup } from "../../components/ui/Card";
import { StatusChip, Tag, type ChipTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Switch } from "../../components/ui/Switch";
import { Tooltip } from "../../components/ui/Tooltip";
import { useAgentsStore } from "../../stores/agents";
import { AgentEditorDialog } from "./AgentEditorDialog";

const AGENT_STATUS_TONE: Record<AgentStatus, ChipTone> = {
  offline: "muted",
  available: "ok",
  running: "accent",
  waiting_input: "info",
  waiting_approval: "warn",
  error: "danger",
  disabled: "muted"
};

const AVATAR_GRADIENTS = [
  "from-violet-500/30 to-fuchsia-500/20 text-violet-400",
  "from-sky-500/30 to-cyan-500/20 text-sky-400",
  "from-amber-500/30 to-orange-500/20 text-amber-400",
  "from-emerald-500/30 to-teal-500/20 text-emerald-400",
  "from-rose-500/30 to-pink-500/20 text-rose-400"
];

function InstanceCard({
  instance,
  index,
  onEdit
}: {
  instance: AgentInstanceConfig;
  index: number;
  onEdit: (instance: AgentInstanceConfig) => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const setInstanceEnabled = useAgentsStore((state) => state.setInstanceEnabled);
  const meta = providerMeta(instance.providerId);

  return (
    <MotionCard className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-gradient-to-br ${AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length]}`}
          >
            <Bot className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold text-ink">{instance.displayName}</h3>
            <p className="text-xs text-ink-3">{meta.name}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <StatusChip
            tone={AGENT_STATUS_TONE[instance.status]}
            label={t(`status.agent.${instance.status}` as MessageKey)}
            pulse={instance.status === "running"}
          />
          <Tooltip content={instance.enabled ? t("agents.instances.disableHint") : t("agents.instances.enableHint")}>
            <span className="inline-flex">
              <Switch
                checked={instance.enabled}
                onCheckedChange={(checked) => void setInstanceEnabled(instance.id, checked)}
                aria-label={`${instance.displayName}: ${instance.enabled ? t("common.enabled") : t("common.disabled")}`}
              />
            </span>
          </Tooltip>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Tag label={instance.executable} className="font-mono" />
        <Tag label={t(`envPolicies.${instance.envPolicyId}.name` as MessageKey)} />
        {instance.credentialStored && <Tag label={t("agents.instances.apiKeySet")} />}
        {instance.baseUrl && <Tag label={instance.baseUrl} className="font-mono" />}
        {instance.baseArgs.length > 0 && (
          <Tag label={`${t("agents.instances.args")}: ${instance.baseArgs.join(" ")}`} className="font-mono" />
        )}
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-line pt-3">
        <span className="text-xs text-ink-3">
          {t("agents.instances.updatedAt", { time: formatRelativeTime(instance.updatedAt, locale) })}
        </span>
        <Button variant="outline" size="sm" onClick={() => onEdit(instance)}>
          <Pencil className="h-3.5 w-3.5" aria-hidden />
          {t("agents.instances.edit")}
        </Button>
      </div>
    </MotionCard>
  );
}

export function InstancesPanel(): JSX.Element {
  const { t } = useI18n();
  const instances = useAgentsStore((state) => state.instances);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AgentInstanceConfig | undefined>();

  const openCreate = (): void => {
    setEditing(undefined);
    setEditorOpen(true);
  };
  const openEdit = (instance: AgentInstanceConfig): void => {
    setEditing(instance);
    setEditorOpen(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-3">{t("agents.instances.desc")}</p>
        <Button variant="primary" onClick={openCreate}>
          <Plus className="h-4 w-4" aria-hidden />
          {t("agents.instances.new")}
        </Button>
      </div>

      {instances.length === 0 ? (
        <EmptyState
          icon={Bot}
          title={t("agents.instances.emptyTitle")}
          description={t("agents.instances.emptyDesc")}
          action={
            <Button variant="primary" onClick={openCreate}>
              <Plus className="h-4 w-4" aria-hidden />
              {t("agents.instances.emptyAction")}
            </Button>
          }
        />
      ) : (
        <StaggerGroup className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {instances.map((instance, index) => (
            <InstanceCard key={instance.id} instance={instance} index={index} onEdit={openEdit} />
          ))}
        </StaggerGroup>
      )}

      <AgentEditorDialog open={editorOpen} onOpenChange={setEditorOpen} instance={editing} />
    </div>
  );
}
