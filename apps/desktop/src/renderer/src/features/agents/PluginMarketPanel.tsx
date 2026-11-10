import { useCallback, useEffect, useState } from "react";
import {
  Download,
  FolderOpen,
  Package,
  RefreshCw,
  Search,
  Store,
  Trash2,
  X,
} from "lucide-react";
import type { ProviderRegistryEntry } from "@agenthub/provider-sdk";
import type { ProviderPluginInfo } from "@agenthub/schemas";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { StatusChip, type ChipTone } from "../../components/ui/Badge";
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
  const [view, setView] = useState<"installed" | "discover">("installed");
  const [query, setQuery] = useState("");
  const [busyPluginId, setBusyPluginId] = useState<string>();
  const zh = locale === "zh-CN";

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

  const needle = query.trim().toLocaleLowerCase();
  const matches = (...values: (string | undefined)[]): boolean =>
    !needle || values.some((value) => value?.toLocaleLowerCase().includes(needle));
  const visibleInstalled = installed.filter((plugin) => matches(
    plugin.id, plugin.manifest?.descriptor.name, plugin.manifest?.descriptor.vendor,
    registry.find((entry) => entry.id === plugin.id)?.description[locale],
  ));
  const visibleRegistry = registry.filter((entry) => matches(entry.id, entry.name, entry.vendor, entry.description[locale]));

  const mutatePlugin = async (id: string, action: () => Promise<unknown>, success?: string): Promise<void> => {
    if (busyPluginId) return;
    setBusyPluginId(id);
    try {
      await action();
      if (success) toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyPluginId(undefined);
    }
  };
  const queueInstall = (entry: ProviderRegistryEntry): void => setPending({
    title: `${entry.name} v${entry.version}`,
    run: () => usePluginsStore.getState().installFromRegistry(entry.id),
  });

  return (
    <div className="plugin-center">
      <div className="plugin-toolbar">
        <nav className="plugin-view-tabs" aria-label={zh ? "插件视图" : "Plugin views"}>
          <button type="button" aria-pressed={view === "installed"} onClick={() => setView("installed")}><Package size={16} aria-hidden />{zh ? "已安装" : "Installed"}<span>{installed.length}</span></button>
          <button type="button" aria-pressed={view === "discover"} onClick={() => setView("discover")}><Store size={16} aria-hidden />{zh ? "发现插件" : "Discover"}<span>{registry.length}</span></button>
        </nav>
        <div className="plugin-toolbar-actions">
          <label className="plugin-search"><Search size={16} aria-hidden /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zh ? "搜索插件" : "Search plugins"} aria-label={zh ? "搜索插件" : "Search plugins"} />{query && <button type="button" aria-label={zh ? "清除搜索" : "Clear search"} onClick={() => setQuery("")}><X size={14} /></button>}</label>
          <Button variant="primary" size="sm" onClick={() => void installLocal()} disabled={installing}><FolderOpen size={15} aria-hidden />{t("agents.market.installLocal")}</Button>
          <Button variant="ghost" size="icon" title={t("common.refresh")} aria-label={t("common.refresh")} disabled={view === "installed" ? loadingInstalled : loadingRegistry} onClick={() => { if (view === "installed") void loadInstalled(); else void usePluginsStore.getState().fetchRegistry(); }}><RefreshCw size={16} className={(view === "installed" ? loadingInstalled : loadingRegistry) ? "animate-spin" : ""} /></Button>
        </div>
      </div>

      <section className="plugin-browser" aria-label={view === "installed" ? t("agents.market.installedTitle") : t("agents.market.registryTitle")} aria-busy={view === "installed" ? loadingInstalled : loadingRegistry}>

        {view === "installed" && loadFailed && <div role="alert" className="plugin-error-banner"><span>{zh ? "无法加载插件，请检查桌面连接。" : "Could not load plugins. Check the desktop connection."}</span><Button variant="outline" size="sm" onClick={() => void loadInstalled()} disabled={loadingInstalled}>{t("common.retry")}</Button></div>}
        {view === "discover" && registryError && <p role="alert" className="plugin-error-banner">{registryError}</p>}
        {((view === "installed" && loadingInstalled && !installed.length) || (view === "discover" && loadingRegistry && !registry.length)) && <div className="plugin-card-grid" role="status" aria-label={t("common.loading")}>{[0, 1, 2].map((index) => <div className="plugin-card plugin-skeleton" key={index}><i /><span /><span /><span /></div>)}</div>}

        {view === "installed" && <div className="plugin-card-grid">
          {visibleInstalled.map((plugin) => {
            const name = plugin.manifest?.descriptor.name ?? plugin.id;
            const update = registry.find((entry) => entry.id === plugin.id && stateFor(entry).action === "update");
            return <article key={plugin.id} className="plugin-card" data-status={plugin.status}>
              <header className="plugin-card-heading"><ProviderAvatar providerId={plugin.manifest?.descriptor.providerId ?? plugin.id} /><div className="plugin-card-copy"><h3>{name}</h3><p className="plugin-card-vendor">{plugin.manifest?.descriptor.vendor}{plugin.manifest?.version && <span>v{plugin.manifest.version}</span>}</p></div></header>
              {registry.find((entry) => entry.id === plugin.id)?.description[locale] && <p className="plugin-card-description">{registry.find((entry) => entry.id === plugin.id)!.description[locale]}</p>}
              {plugin.error && <p className="plugin-card-error" role="alert">{plugin.error}</p>}
              <footer className="plugin-card-footer"><div className="plugin-enable-control"><Switch id={`plugin-enable-${plugin.id}`} checked={plugin.enabled} disabled={!!busyPluginId || installing} onCheckedChange={(checked) => void mutatePlugin(plugin.id, () => usePluginsStore.getState().setEnabled(plugin.id, checked))} aria-label={`${name} ${plugin.enabled ? t("common.enabled") : t("common.disabled")}`} /><label htmlFor={`plugin-enable-${plugin.id}`}>{plugin.enabled ? (zh ? "已启用" : "Enabled") : (zh ? "已停用" : "Disabled")}</label></div><div className="plugin-card-actions">{plugin.status === "error" && <StatusChip className="plugin-status" tone={STATUS_TONE[plugin.status]} label={t(`agents.market.status.${plugin.status}`)} />}{update && <Button variant="ghost" size="sm" disabled={!!busyPluginId || installing} onClick={() => queueInstall(update)}><Download size={14} />{t("agents.market.update")}</Button>}<Button variant="ghost" size="sm" className="plugin-remove" title={t("agents.market.uninstall")} aria-label={`${t("agents.market.uninstall")} ${name}`} disabled={!!busyPluginId || installing} onClick={() => void mutatePlugin(plugin.id, () => usePluginsStore.getState().uninstall(plugin.id), t("agents.market.removed"))}><Trash2 size={14} aria-hidden />{t("agents.market.uninstall")}</Button></div></footer>
            </article>;
          })}
        </div>}

        {view === "discover" && <div className="plugin-card-grid">
          {visibleRegistry.map((entry) => {
            const state = stateFor(entry);
            return <article key={entry.id} className="plugin-card plugin-discovery-card">
              <header className="plugin-card-heading"><ProviderAvatar providerId={entry.id} /><div className="plugin-card-copy"><h3>{entry.name}</h3><p className="plugin-card-vendor">{entry.vendor}<span>v{entry.version}</span></p></div></header>
              <p className="plugin-card-description">{entry.description[locale]}</p>
              <footer className="plugin-card-footer"><span>{state.action === "installed" && state.installedRecord && <StatusChip className="plugin-status" tone={STATUS_TONE[state.installedRecord.status]} label={state.installedRecord.status === "error" ? t("agents.market.status.error") : (zh ? "已安装" : "Installed")} />}</span>{state.action === "installed" ? <button className="plugin-manage-link" type="button" onClick={() => setView("installed")}>{zh ? "管理" : "Manage"}</button> : <Button variant={state.action === "update" ? "outline" : "primary"} size="sm" disabled={installing || !!busyPluginId} onClick={() => queueInstall(entry)}><Download size={14} aria-hidden />{state.action === "update" ? t("agents.market.update") : t("agents.market.install")}</Button>}</footer>
            </article>;
          })}
        </div>}

        {view === "installed" && !loadingInstalled && !loadFailed && !visibleInstalled.length && <div className="plugin-empty"><EmptyState icon={query ? Search : Package} title={query ? (zh ? "没有找到匹配的插件" : "No matching plugins") : t("agents.market.emptyTitle")} action={query ? <Button size="sm" onClick={() => setQuery("")}>{zh ? "清除搜索" : "Clear search"}</Button> : <Button variant="primary" size="sm" onClick={() => setView("discover")}><Store size={14} />{zh ? "发现插件" : "Discover plugins"}</Button>} /></div>}
        {view === "discover" && !loadingRegistry && !registryError && !visibleRegistry.length && <div className="plugin-empty"><EmptyState icon={query ? Search : Store} title={query ? (zh ? "没有找到匹配的插件" : "No matching plugins") : t("agents.market.registryEmpty")} action={query ? <Button size="sm" onClick={() => setQuery("")}>{zh ? "清除搜索" : "Clear search"}</Button> : undefined} /></div>}
      </section>

      <Dialog open={!!pending} onOpenChange={(open) => { if (!open && !installing) setPending(undefined); }} title={t("agents.market.confirmTitle")} footer={<><Button variant="ghost" size="sm" disabled={installing} onClick={() => setPending(undefined)}>{t("common.cancel")}</Button><Button variant="primary" size="sm" disabled={installing} onClick={() => void confirmInstall()}>{installing ? t("common.loading") : t("agents.market.confirmInstall")}</Button></>}>
        <div className="plugin-install-preview"><FolderOpen size={22} aria-hidden /><p>{pending?.title}</p></div>
        <p className="mt-4 rounded-lg bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">{t("agents.market.confirmWarning")}</p>
      </Dialog>
    </div>
  );
}
