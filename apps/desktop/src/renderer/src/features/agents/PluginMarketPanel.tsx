import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import {
  ArrowUp,
  Check,
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
import { Switch } from "../../components/ui/Switch";
import { compareVersions, usePluginsStore } from "../../stores/plugins";
import { toast } from "../../stores/toast";
import { useUiReducedMotion } from "../../lib/ui-motion";
import "./plugin-market.css";

type PendingInstall =
  | { kind: "local"; path: string }
  | { kind: "registry"; entry: ProviderRegistryEntry; action: "install" | "update" };

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
  const reducedMotion = useUiReducedMotion();
  const tabList = useRef<HTMLElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);

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

  useLayoutEffect(() => {
    const list = tabList.current;
    const line = indicator.current;
    if (!list || !line) return;
    const sync = () => {
      const active = list.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      if (!active) return;
      // Scale a fixed 100px line to the measured width without animating layout.
      line.style.transform = `translateX(${active.offsetLeft}px) scaleX(${active.offsetWidth / 100})`;
      line.style.opacity = "1";
    };
    sync();
    const observer = new ResizeObserver(sync);
    list.querySelectorAll("button").forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [view]);

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
      setPending({ kind: "local", path: dir });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmInstall = async (): Promise<void> => {
    if (!pending || installing || busyPluginId) return;
    setInstalling(true);
    try {
      const store = usePluginsStore.getState();
      const record = await (pending.kind === "local" ? store.installLocal(pending.path) : store.installFromRegistry(pending.entry.id));
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

  const installedById = new Map(installed.map((plugin) => [plugin.id, plugin]));
  const registryById = new Map(registry.map((entry) => [entry.id, entry]));
  const needle = query.trim().toLocaleLowerCase();
  const matches = (...values: (string | undefined)[]): boolean =>
    !needle || values.some((value) => value?.toLocaleLowerCase().includes(needle));
  const visibleInstalled = installed.filter((plugin) => matches(
    plugin.id, plugin.manifest?.descriptor.name, plugin.manifest?.descriptor.vendor,
    registryById.get(plugin.id)?.description[locale],
  ));
  const visibleRegistry = registry.filter((entry) => matches(entry.id, entry.name, entry.vendor, entry.description[locale]));

  const mutatePlugin = async (id: string, action: () => Promise<unknown>, success?: string): Promise<void> => {
    if (busyPluginId || installing) return;
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
  const busy = !!busyPluginId || installing;
  const loading = view === "installed" ? loadingInstalled : loadingRegistry;
  const workingId = installing && pending?.kind === "registry" ? pending.entry.id : undefined;
  const enabledCount = installed.filter((plugin) => plugin.enabled).length;
  const visibleCount = view === "installed" ? visibleInstalled.length : visibleRegistry.length;
  const initialLoading = loading && !(view === "installed" ? installed.length : registry.length);
  const issue = view === "installed" ? loadFailed : registryError;
  const refresh = () => view === "installed" ? void loadInstalled() : void usePluginsStore.getState().fetchRegistry();
  const queueInstall = (entry: ProviderRegistryEntry, action: "install" | "update") =>
    setPending({ kind: "registry", entry, action });

  const registryAction = (entry: ProviderRegistryEntry, action: "install" | "update") => {
    const working = workingId === entry.id;
    const Icon = working ? RefreshCw : action === "update" ? ArrowUp : Download;
    return <Button
      type="button"
      variant={action === "update" ? "ghost" : "primary"}
      size="sm"
      className={action === "update" ? "plugin-update" : "plugin-install"}
      disabled={busy}
      aria-busy={working}
      onClick={() => queueInstall(entry, action)}
    >
      <Icon size={13} aria-hidden />
      {working ? (action === "update" ? (zh ? "更新中" : "Updating") : (zh ? "安装中" : "Installing")) : t(`agents.market.${action}`)}
    </Button>;
  };
  const pendingTitle = pending?.kind === "local" ? pending.path : pending && `${pending.entry.name} v${pending.entry.version}`;

  return (
    <div className="plugin-center" data-reduced-motion={reducedMotion}>
      <header className="plugin-page-heading">
        <div>
          <h1>{zh ? "插件" : "Plugins"}</h1>
          <span className="plugin-count">{zh ? `已启用 ${enabledCount} / ${installed.length}` : `${enabledCount} / ${installed.length} enabled`}</span>
        </div>
        <Button type="button" variant="primary" size="sm" className="plugin-local-install" onClick={() => void installLocal()} disabled={busy}>
          <FolderOpen size={15} aria-hidden />{t("agents.market.installLocal")}
        </Button>
      </header>
      <div className="plugin-toolbar">
        <nav className="plugin-view-tabs" ref={tabList} aria-label={zh ? "插件视图" : "Plugin views"}>
          <button type="button" aria-pressed={view === "installed"} onClick={() => setView("installed")}>{zh ? "已安装" : "Installed"}<span>{installed.length}</span></button>
          <button type="button" aria-pressed={view === "discover"} onClick={() => setView("discover")}>{zh ? "发现插件" : "Discover"}<span>{registry.length}</span></button>
          <span className="plugin-tab-indicator" ref={indicator} aria-hidden />
        </nav>
        <div className="plugin-toolbar-actions">
          <label className="plugin-search">
            <span className="plugin-search-content">
              <Search size={15} aria-hidden />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zh ? "搜索插件" : "Search plugins"} aria-label={zh ? "搜索插件" : "Search plugins"} />
            </span>
            {query && <button type="button" aria-label={zh ? "清除搜索" : "Clear search"} onClick={() => setQuery("")}><X size={14} aria-hidden /></button>}
          </label>
          <Button type="button" variant="ghost" size="icon" className="plugin-refresh" title={t("common.refresh")} aria-label={t("common.refresh")} disabled={loading} aria-busy={loading} onClick={refresh}>
            <RefreshCw size={15} aria-hidden />
          </Button>
        </div>
      </div>

      <section className="plugin-browser" aria-label={view === "installed" ? t("agents.market.installedTitle") : t("agents.market.registryTitle")} aria-busy={loading}>
        {issue && <div role="alert" className="plugin-error-banner">
          <span>{view === "installed" ? (zh ? "无法加载插件，请检查桌面连接。" : "Could not load plugins. Check the desktop connection.") : registryError}</span>
          <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={loading}>{t("common.retry")}</Button>
        </div>}
        {initialLoading && <div className="plugin-card-grid" role="status" aria-label={t("common.loading")}>
          {[0, 1, 2].map((index) => <div className="plugin-card plugin-skeleton" key={index} aria-hidden><i /><span /><span /><span /></div>)}
        </div>}

        {visibleCount > 0 && <div className="plugin-card-grid" key={`${view}:${needle}`}>
          {view === "installed" ? visibleInstalled.map((plugin, index) => {
            const descriptor = plugin.manifest?.descriptor;
            const name = descriptor?.name ?? plugin.id;
            const entry = registryById.get(plugin.id);
            const version = plugin.manifest?.version;
            const update = entry && version && compareVersions(entry.version, version) > 0;
            return <PluginCard
              key={plugin.id} index={index} reducedMotion={reducedMotion}
              providerId={descriptor?.providerId ?? plugin.id} name={name} vendor={descriptor?.vendor} version={version}
              description={entry?.description[locale]}
              descriptionFallback={entry ? (zh ? "官方扩展插件" : "Official extension") : (zh ? "暂无说明" : "No description")}
              status={plugin.status} enabled={plugin.enabled} error={plugin.error}
              control={<Switch checked={plugin.enabled} disabled={busy} onCheckedChange={(checked) => void mutatePlugin(plugin.id, () => usePluginsStore.getState().setEnabled(plugin.id, checked))} aria-label={name} />}
              footer={<>
                <span className="plugin-card-status" data-status={plugin.status}>
                  <i aria-hidden />{plugin.status === "loaded" ? (zh ? "运行中" : "Running") : t(`agents.market.status.${plugin.status}`)}
                </span>
                <div className="plugin-card-actions">
                  {update && registryAction(entry, "update")}
                  <Button type="button" variant="ghost" size="sm" className="plugin-remove" aria-label={`${t("agents.market.uninstall")} ${name}`} disabled={busy} onClick={() => void mutatePlugin(plugin.id, () => usePluginsStore.getState().uninstall(plugin.id), t("agents.market.removed"))}>
                    <Trash2 size={13} aria-hidden />{t("agents.market.uninstall")}
                  </Button>
                </div>
              </>}
            />;
          }) : visibleRegistry.map((entry, index) => {
            const record = installedById.get(entry.id);
            const current = record?.manifest?.version;
            const update = current && compareVersions(entry.version, current) > 0;
            return <PluginCard
              key={entry.id} index={index} reducedMotion={reducedMotion}
              providerId={record?.manifest?.descriptor.providerId ?? entry.id} name={entry.name} vendor={entry.vendor} version={entry.version}
              description={entry.description[locale]} descriptionFallback={zh ? "官方扩展插件" : "Official extension"}
              footer={<>
                {record && <span className="plugin-card-status plugin-registry-status" data-status={record.status === "error" ? "error" : "installed"}>
                  {record.status === "error" ? <i aria-hidden /> : <Check size={13} aria-hidden />}
                  {record.status === "error" ? t("agents.market.status.error") : (zh ? "已安装" : "Installed")}
                </span>}
                <div className="plugin-card-actions">{update ? registryAction(entry, "update") : record
                  ? <button className="plugin-manage-link" type="button" onClick={() => setView("installed")}>{zh ? "管理" : "Manage"}</button>
                  : registryAction(entry, "install")}
                </div>
              </>}
            />;
          })}
        </div>}

        {!loading && !issue && visibleCount === 0 && <div className="plugin-empty">
          <EmptyState
            icon={needle ? Search : view === "installed" ? Package : Store}
            title={needle ? (zh ? "没有找到匹配的插件" : "No matching plugins") : t(view === "installed" ? "agents.market.emptyTitle" : "agents.market.registryEmpty")}
            action={needle ? <Button type="button" size="sm" onClick={() => setQuery("")}>{zh ? "清除搜索" : "Clear search"}</Button>
              : view === "installed" ? <Button type="button" variant="primary" size="sm" onClick={() => setView("discover")}><Store size={14} aria-hidden />{zh ? "发现插件" : "Discover plugins"}</Button> : undefined}
          />
        </div>}
      </section>

      <Dialog
        open={!!pending}
        onOpenChange={(open) => { if (!open && !installing) setPending(undefined); }}
        title={pending?.kind === "registry" && pending.action === "update" ? (zh ? "更新插件" : "Update plugin") : t("agents.market.confirmTitle")}
        widthClass="max-w-lg plugin-install-dialog"
        footer={<>
          <Button type="button" variant="ghost" size="sm" disabled={installing} onClick={() => setPending(undefined)}>{t("common.cancel")}</Button>
          <Button type="button" variant="primary" size="sm" onClick={() => void confirmInstall()} disabled={busy} aria-busy={installing}>
            {installing && <RefreshCw size={14} aria-hidden />}
            {installing ? t("common.loading") : pending?.kind === "registry" && pending.action === "update" ? (zh ? "确认更新" : "Confirm update") : t("agents.market.confirmInstall")}
          </Button>
        </>}
      >
        <div className="plugin-install-preview"><FolderOpen size={18} aria-hidden /><p>{pendingTitle}</p></div>
        <p className="plugin-install-warning">{t("agents.market.confirmWarning")}</p>
      </Dialog>
    </div>
  );
}

function PluginCard({ index, reducedMotion, providerId, name, vendor, version, description, descriptionFallback, status, enabled, error, control, footer }: {
  index: number;
  reducedMotion: boolean;
  providerId: string;
  name: string;
  vendor?: string;
  version?: string;
  description?: string;
  descriptionFallback: string;
  status?: ProviderPluginInfo["status"];
  enabled?: boolean;
  error?: string;
  control?: ReactNode;
  footer: ReactNode;
}): JSX.Element {
  const light = useRef<HTMLSpanElement>(null);
  const pointerFrame = useRef(0);
  const track = (event: PointerEvent<HTMLElement>): void => {
    if (reducedMotion || event.pointerType !== "mouse") return;
    const card = event.currentTarget;
    const { clientX, clientY } = event;
    cancelAnimationFrame(pointerFrame.current);
    pointerFrame.current = requestAnimationFrame(() => {
      const bounds = card.getBoundingClientRect();
      light.current?.style.setProperty("--mx", `${clientX - bounds.left}px`);
      light.current?.style.setProperty("--my", `${clientY - bounds.top}px`);
    });
  };
  useEffect(() => () => cancelAnimationFrame(pointerFrame.current), []);
  const summary = description?.trim();

  return (
    <div className="plugin-card-slot" style={{ "--plugin-entry-delay": `${index * 32}ms` } as CSSProperties}>
      <article className="plugin-card" data-status={status} data-enabled={enabled} onPointerEnter={track} onPointerMove={track}>
        <span className="plugin-card-light" ref={light} aria-hidden />
        <header className="plugin-card-heading">
          <ProviderAvatar providerId={providerId} />
          <div className="plugin-card-copy">
            <h2 title={name}>{name}</h2>
            <p className="plugin-card-vendor" title={[vendor, version && `v${version}`].filter(Boolean).join(" · ")}>
              {vendor && <span>{vendor}</span>}
              {version && <span>{vendor && " · "}v{version}</span>}
            </p>
          </div>
          {control}
        </header>
        <p className="plugin-card-description" data-placeholder={!summary} title={summary}>{summary || descriptionFallback}</p>
        {error && <p className="plugin-card-error" role="alert">{error}</p>}
        <footer className="plugin-card-footer">{footer}</footer>
      </article>
    </div>
  );
}
