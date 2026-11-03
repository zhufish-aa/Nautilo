import { useCallback, useEffect, useState } from "react";
import {
  Download,
  FolderOpen,
  Package,
  RefreshCw,
  Store,
  Trash2,
} from "lucide-react";
import type { ProviderRegistryEntry } from "@agenthub/provider-sdk";
import type { ProviderPluginInfo } from "@agenthub/schemas";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { StatusChip, Tag, type ChipTone } from "../../components/ui/Badge";
import { Switch } from "../../components/ui/Switch";
import { compareVersions, usePluginsStore } from "../../stores/plugins";
import { toast } from "../../stores/toast";

const STATUS_TONE: Record<ProviderPluginInfo["status"], ChipTone> = {
  loaded: "ok",
  disabled: "muted",
  error: "danger",
};

interface PendingInstall {
  title: string;
  run: () => Promise<ProviderPluginInfo>;
}

/**
 * Provider plugin marketplace: browse the registry, install/update/remove
 * plugins, and toggle them. Installing runs the confirmed action against the
 * daemon; the provider catalog refreshes automatically afterwards.
 */
export function PluginMarketPanel(): JSX.Element {
  const { t, locale } = useI18n();
  const installed = usePluginsStore((state) => state.installed);
  const registry = usePluginsStore((state) => state.registry);
  const registryError = usePluginsStore((state) => state.registryError);
  const loadingRegistry = usePluginsStore((state) => state.loadingRegistry);
  const [pending, setPending] = useState<PendingInstall | undefined>();
  const [installing, setInstalling] = useState(false);

  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingInstalled, setLoadingInstalled] = useState(false);
  const loadInstalled = useCallback(async (): Promise<void> => {
    setLoadingInstalled(true);
    setLoadFailed(false);
    try {
      await usePluginsStore.getState().hydrate();
    } catch {
      setLoadFailed(true);
    } finally {
      setLoadingInstalled(false);
    }
  }, []);

  useEffect(() => {
    void loadInstalled();
    void usePluginsStore.getState().fetchRegistry();
  }, [loadInstalled]);

  const installLocal = async (): Promise<void> => {
    try {
      const bridge = getBridge();
      if (!bridge)
        throw new Error(
          locale === "zh-CN"
            ? "请在桌面客户端中安装插件。"
            : "Open the desktop app to install plugins.",
        );
      const dir = await bridge.dialog.pickDirectory();
      if (!dir) return;
      setPending({
        title: dir,
        run: () => usePluginsStore.getState().installLocal(dir),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmInstall = async (): Promise<void> => {
    if (!pending) return;
    setInstalling(true);
    try {
      const record = await pending.run();
      if (record.status === "error")
        toast.error(record.error ?? t("agents.market.installFailed"));
      else
        toast.success(
          t("agents.market.installed", {
            name: record.manifest?.descriptor.name ?? record.id,
          }),
        );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setInstalling(false);
      setPending(undefined);
    }
  };

  const stateFor = (
    entry: ProviderRegistryEntry,
  ): {
    action: "install" | "update" | "installed";
    installedRecord?: ProviderPluginInfo;
  } => {
    const record = installed.find((item) => item.id === entry.id);
    if (!record) return { action: "install" };
    const current = record.manifest?.version;
    if (current && compareVersions(entry.version, current) > 0)
      return { action: "update", installedRecord: record };
    return { action: "installed", installedRecord: record };
  };

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">
            {t("agents.market.installedTitle")}
          </h2>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void installLocal()}
          >
            <FolderOpen className="h-4 w-4" aria-hidden />
            {t("agents.market.installLocal")}
          </Button>
        </div>
        {loadFailed && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 border-y border-line py-4 text-sm"
          >
            <span className="text-danger">
              {locale === "zh-CN"
                ? "无法加载插件，请检查桌面连接。"
                : "Could not load plugins. Check the desktop connection."}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadInstalled()}
              disabled={loadingInstalled}
            >
              {t("common.retry")}
            </Button>
          </div>
        )}
        {loadingInstalled && (
          <p role="status" className="py-6 text-sm text-ink-3">
            {t("common.loading")}
          </p>
        )}
        {installed.length === 0 &&
        (loadingInstalled || loadFailed) ? null : installed.length === 0 ? (
          <EmptyState
            icon={Package}
            title={t("agents.market.emptyTitle")}
            description={t("agents.market.emptyDesc")}
          />
        ) : (
          <div className="divide-y divide-line rounded-xl border border-line">
            {installed.map((plugin) => (
              <div key={plugin.id} className="flex flex-col gap-2 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-ink">
                      {plugin.manifest?.descriptor.name ?? plugin.id}
                    </h3>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {plugin.manifest?.descriptor.vendor}
                      {plugin.manifest?.version
                        ? ` · v${plugin.manifest.version}`
                        : ""}
                    </p>
                  </div>
                  <StatusChip
                    tone={STATUS_TONE[plugin.status]}
                    label={t(`agents.market.status.${plugin.status}`)}
                  />
                </div>
                {plugin.error && (
                  <p className="rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
                    {plugin.error}
                  </p>
                )}
                <div className="flex items-center justify-end gap-4">
                  <Switch
                    checked={plugin.enabled}
                    onCheckedChange={(checked) =>
                      void usePluginsStore
                        .getState()
                        .setEnabled(plugin.id, checked)
                        .catch((error) => toast.error(String(error)))
                    }
                    aria-label={`${plugin.id} ${plugin.enabled ? t("common.enabled") : t("common.disabled")}`}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void usePluginsStore
                        .getState()
                        .uninstall(plugin.id)
                        .then(() => toast.success(t("agents.market.removed")))
                        .catch((error) => toast.error(String(error)))
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    {t("agents.market.uninstall")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">
            {t("agents.market.registryTitle")}
          </h2>
          <Button
            variant="ghost"
            size="sm"
            disabled={loadingRegistry}
            onClick={() => void usePluginsStore.getState().fetchRegistry()}
          >
            <RefreshCw
              className={`h-4 w-4 ${loadingRegistry ? "animate-spin" : ""}`}
              aria-hidden
            />
            {t("common.refresh")}
          </Button>
        </div>
        {registryError && (
          <Card className="px-4 py-3 text-xs text-danger">{registryError}</Card>
        )}
        {!registryError && registry.length === 0 && !loadingRegistry && (
          <EmptyState
            icon={Store}
            title={t("agents.market.registryEmpty")}
            description={t("agents.market.registryEmptyDesc")}
          />
        )}
        <div className="divide-y divide-line rounded-xl border border-line">
          {registry.map((entry) => {
            const state = stateFor(entry);
            return (
              <div
                key={entry.id}
                className="relative flex flex-col gap-2 px-4 py-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-ink">
                      {entry.name}
                    </h3>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {entry.vendor} · v{entry.version}
                    </p>
                  </div>
                  <Tag label={entry.id} />
                </div>
                <details className="text-xs text-ink-3">
                  <summary className="w-fit cursor-pointer">
                    {locale === "zh-CN" ? "详情" : "Details"}
                  </summary>
                  <p className="mt-2 leading-relaxed">
                    {entry.description[locale]}
                  </p>
                </details>
                <div className="flex justify-end">
                  {state.action === "installed" ? (
                    <StatusChip
                      tone="ok"
                      label={t("agents.market.status.loaded")}
                    />
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setPending({
                          title: `${entry.name} v${entry.version}`,
                          run: () =>
                            usePluginsStore
                              .getState()
                              .installFromRegistry(entry.id),
                        })
                      }
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden />
                      {state.action === "update"
                        ? t("agents.market.update")
                        : t("agents.market.install")}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <Dialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open && !installing) setPending(undefined);
        }}
        title={t("agents.market.confirmTitle")}
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={installing}
              onClick={() => setPending(undefined)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={installing}
              onClick={() => void confirmInstall()}
            >
              {installing
                ? t("common.loading")
                : t("agents.market.confirmInstall")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">{pending?.title}</p>
        <p className="mt-2 rounded-lg bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
          {t("agents.market.confirmWarning")}
        </p>
      </Dialog>
    </div>
  );
}
