import { Loader2, RefreshCw, ShieldAlert, Terminal } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { formatRelativeTime } from "../../lib/utils";
import { PROVIDERS, providerMeta } from "../../lib/provider-catalog";
import type { ProviderDetectionStatus, ProviderInstallation } from "../../lib/types";
import { MotionCard, StaggerGroup } from "../../components/ui/Card";
import { StatusChip, Tag, type ChipTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { useAgentsStore } from "../../stores/agents";
import { toast } from "../../stores/toast";

const STATUS_TONE: Record<ProviderDetectionStatus, ChipTone> = {
  ready: "ok",
  missing: "muted",
  outdated: "warn",
  error: "danger"
};

const PROVIDER_GRADIENTS = [
  "from-violet-500/25 to-fuchsia-500/15 text-violet-400",
  "from-amber-500/25 to-orange-500/15 text-amber-400",
  "from-sky-500/25 to-cyan-500/15 text-sky-400",
  "from-emerald-500/25 to-teal-500/15 text-emerald-400",
  "from-slate-500/25 to-gray-500/15 text-slate-400"
];

function ProviderCard({
  installation,
  index
}: {
  installation: ProviderInstallation;
  index: number;
}): JSX.Element {
  const { t, locale } = useI18n();
  const redetect = useAgentsStore((state) => state.redetect);
  const detecting = useAgentsStore((state) => !!state.detecting[installation.providerId]);
  const meta = providerMeta(installation.providerId);

  const handleRedetect = async (): Promise<void> => {
    await redetect(installation.providerId);
    toast.success(t("agents.providers.redetectDone", { name: meta.name }));
  };

  const hintKey: Partial<Record<ProviderDetectionStatus, MessageKey>> = {
    missing: "agents.providers.missingHint",
    outdated: "agents.providers.outdatedHint",
    error: "agents.providers.errorHint"
  };

  return (
    <MotionCard className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-gradient-to-br font-mono text-sm font-bold ${PROVIDER_GRADIENTS[index % PROVIDER_GRADIENTS.length]}`}
          >
            {meta.name.slice(0, 1)}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold text-ink">{meta.name}</h3>
            <p className="text-xs text-ink-3">{meta.vendor}</p>
          </div>
        </div>
        <StatusChip tone={STATUS_TONE[installation.status]} label={t(`status.provider.${installation.status}`)} />
      </div>

      <div className="space-y-2.5 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="shrink-0 text-ink-3">{t("agents.providers.executable")}</span>
          <span
            className="min-w-0 truncate font-mono text-xs text-ink-2"
            title={installation.executable}
          >
            {installation.executable ?? "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="shrink-0 text-ink-3">{t("agents.providers.version")}</span>
          <span className="font-mono text-xs text-ink-2">
            {installation.version ?? "—"}
            {installation.status === "outdated" && meta.minVersion && (
              <span className="ml-2 text-warn">
                {t("agents.providers.minVersion", { version: meta.minVersion })}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="shrink-0 text-ink-3">{t("agents.providers.capabilities")}</span>
          <span className="flex flex-wrap justify-end gap-1.5">
            {meta.capabilities.map((capability) => (
              <Tag key={capability} label={t(`capabilities.${capability}` as MessageKey)} />
            ))}
          </span>
        </div>
      </div>

      {hintKey[installation.status] && (
        <p className="rounded-lg border border-line bg-card-hover px-3 py-2 text-xs leading-relaxed text-ink-3">
          {t(hintKey[installation.status]!)}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between border-t border-line pt-3">
        <span className="text-xs text-ink-3">
          {t("agents.providers.checkedAt", { time: formatRelativeTime(installation.checkedAt, locale) })}
        </span>
        <Button variant="outline" size="sm" onClick={() => void handleRedetect()} disabled={detecting}>
          {detecting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          )}
          {detecting ? t("agents.providers.redetecting") : t("agents.providers.redetect")}
        </Button>
      </div>
    </MotionCard>
  );
}

export function ProvidersPanel(): JSX.Element {
  const { t } = useI18n();
  const installations = useAgentsStore((state) => state.installations);

  return (
    <div className="space-y-4">
      <div
        role="note"
        className="flex items-start gap-3 rounded-2xl border border-info/25 bg-info/10 px-4 py-3"
      >
        <ShieldAlert className="mt-0.5 h-4.5 w-4.5 shrink-0 text-info" aria-hidden />
        <p className="text-[13px] leading-relaxed text-ink-2">{t("agents.providers.notice")}</p>
      </div>
      <p className="text-sm text-ink-3">{t("agents.providers.desc")}</p>
      <StaggerGroup className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {installations.map((installation, index) => (
          <ProviderCard
            key={installation.providerId}
            installation={installation}
            index={index}
          />
        ))}
      </StaggerGroup>
      {installations.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-ink-3">
          <Terminal className="h-4 w-4" aria-hidden />
          {t("common.none")}
        </div>
      )}
    </div>
  );
}

export { PROVIDERS };
