import { useEffect, useMemo, useState, type DragEvent } from "react";
import {
  Blocks,
  Import,
  Plus,
  Search,
  Wrench,
} from "lucide-react";
import type { CapabilityKind, ProviderCapability } from "@agenthub/domain";
import { isElectron } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { toDaemonProviderId } from "../../lib/core-mappers";
import { capabilityEnabledFor } from "../../lib/capability-enablement";
import { capabilityOrigin, capabilityDescription, type CapabilityOriginKind } from "../../lib/capability-origin";
import { providerMeta, useProviderMetas } from "../../lib/provider-catalog";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Input } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { toast } from "../../stores/toast";
import { useProviderToolsStore } from "../../stores/provider-tools";
import { CapabilityEditorDialog, type CapabilityDialogState } from "./CapabilityEditorDialog";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { McpWorkbench } from "./McpWorkbench";
import { ResourceSyncDialog } from "./ResourceSyncDialog";
import {
  CapabilityImportDialog,
  type CapabilityImportSeed,
} from "./CapabilityImportDialog";
import "./skills-workbench.css";

/** A dropped file can seed the wizard: .json goes to the MCP tab, .md to Skills. */
const DROP_EXTENSIONS = [".json", ".md", ".markdown"];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProviderToolsPanel({ kind = "skill" }: { kind?: CapabilityKind }): JSX.Element {
  const { t, locale } = useI18n();
  const [syncOpen, setSyncOpen] = useState(false);
  const providers = useProviderMetas();
  const tools = useProviderToolsStore((state) => state.tools);
  const loading = useProviderToolsStore((state) => state.loading);
  const loaded = useProviderToolsStore((state) => state.loaded);
  const loadError = useProviderToolsStore((state) => state.error);
  const load = useProviderToolsStore((state) => state.load);
  const toggle = useProviderToolsStore((state) => state.toggleForHarness);
  const remove = useProviderToolsStore((state) => state.remove);

  const [selectedProviderId, setProviderId] = useState("");
  const providerId = providers.some((provider) => provider.id === selectedProviderId) ? selectedProviderId : providers[0]?.id || "";
  const daemonProviderId = toDaemonProviderId(providerId);
  const harnessName = providerMeta(providerId).name;
  const [toggling, setToggling] = useState<string[]>([]);
  const zh = locale === "zh-CN";
  const [query, setQuery] = useState("");
  const [view, setView] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [editor, setEditor] = useState<CapabilityDialogState>();
  const [importOpen, setImportOpen] = useState(false);
  const [importSeed, setImportSeed] = useState<
    CapabilityImportSeed | undefined
  >(undefined);
  const [dropActive, setDropActive] = useState(false);
  const [deleting, setDeleting] = useState<ProviderCapability | undefined>(
    undefined,
  );
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    if (isElectron && !loaded) void load();
  }, [load, loaded]);

  const inventory = useMemo(() => tools.filter(tool => tool.kind === kind), [tools, kind]);
  const enabledCount = inventory.filter(tool => capabilityEnabledFor(tool, daemonProviderId)).length;
  const originNames: Record<CapabilityOriginKind, string> = {
    builtin: zh ? "Nautilo 内置" : "Built into Nautilo",
    plugin: zh ? "来自插件" : "From plugins",
    local: zh ? "本机导入" : "Imported locally",
    custom: zh ? "手动创建" : "Created manually",
    unknown: zh ? "来源未记录" : "Source not recorded"
  };
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return inventory.filter((tool) => {
      const enabled = capabilityEnabledFor(tool, daemonProviderId);
      if (view === "enabled" && !enabled || view === "disabled" && enabled) return false;
      const origin = capabilityOrigin(tool);
      if (sourceFilter !== "all" && origin.kind !== sourceFilter) return false;
      if (!normalized) return true;
      return `${tool.name} ${tool.description} ${origin.label} ${origin.path ?? ""} ${tool.tags.join(" ")}`
        .toLowerCase()
        .includes(normalized);
    }).sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [inventory, query, view, sourceFilter, daemonProviderId, locale]);
  const groups = (["builtin", "local", "plugin", "custom", "unknown"] as const)
    .map(origin => ({ origin, items: filtered.filter(tool => capabilityOrigin(tool).kind === origin) }))
    .filter(group => group.items.length);

  if (!isElectron) {
    return (
      <EmptyState
        icon={Wrench}
        title={t("agents.tools.desktopOnlyTitle")}
        description={t("agents.tools.desktopOnlyDesc")}
      />
    );
  }

  const openCreate = (): void => {
    setEditor({ mode: "create" });
  };

  const openImport = (seed?: CapabilityImportSeed): void => {
    setImportSeed(seed ?? { tab: kind === "mcp" ? "mcp" : "skills", text: "" });
    setImportOpen(true);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDropActive(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!DROP_EXTENSIONS.some((ext) => lower.endsWith(ext))) return;
    void file
      .text()
      .then((text) =>
        openImport({
          tab: lower.endsWith(".json") ? "mcp" : "skills",
          text,
          fileName: file.name,
        }),
      )
      .catch((error: unknown) => toast.error(messageOf(error)));
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDropActive(true);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    // Only hide when the pointer actually leaves the wrapper, not a child.
    if (event.currentTarget.contains(event.relatedTarget as Node | null))
      return;
    setDropActive(false);
  };

  const openEdit = (tool: ProviderCapability): void => {
    setEditor({ mode: "edit", capability: tool });
  };

  const handleToggle = (tool: ProviderCapability, enabled: boolean): void => {
    setToggling((ids) => [...ids, tool.id]);
    void toggle(tool.id, daemonProviderId, enabled)
      .catch((error: unknown) => toast.error(messageOf(error)))
      .finally(() => setToggling((ids) => ids.filter((id) => id !== tool.id)));
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await remove(deleting.id);
      toast.success(t("agents.tools.deletedToast", { name: deleting.name }));
      setDeleting(undefined);
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setDeleteBusy(false);
    }
  };

  const actions = <div className="capability-heading-actions">
    <Button variant="outline" size="sm" onClick={() => setSyncOpen(true)}>{zh ? "原生同步" : "Native sync"}</Button>
    <Button variant="outline" size="sm" onClick={() => openImport()}>
      <Import size={14} aria-hidden />{t("agents.tools.import.button")}
    </Button>
    <Button variant="primary" size="sm" onClick={openCreate}>
      <Plus size={15} aria-hidden />{kind === "mcp" ? (zh ? "添加 MCP" : "Add MCP") : (zh ? "添加 Skill" : "Add Skill")}
    </Button>
  </div>;
  const harness = <div className="capability-harness-select">
    <ProviderAvatar providerId={providerId} size="sm" />
    <SelectField value={providerId} onValueChange={setProviderId} aria-label="Harness"
      options={providers.map(provider => ({ value: provider.id, label: provider.name }))} />
  </div>;
  const search = <div className="capability-search relative">
    <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
    <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t("agents.tools.searchPlaceholder")}
      className="pl-9" aria-label={t("agents.tools.searchPlaceholder")} />
  </div>;
  const filters = [
    { id: "all", label: zh ? "全部" : "All", count: inventory.length },
    { id: "enabled", label: zh ? "已启用" : "Enabled", count: enabledCount },
    { id: "disabled", label: zh ? "未启用" : "Disabled", count: inventory.length - enabledCount },
  ];
  const sourceSelect = <SelectField value={sourceFilter} onValueChange={setSourceFilter}
    aria-label={zh ? "筛选来源" : "Filter by source"} className="capability-source-filter"
    options={[{ value: "all", label: zh ? "所有来源" : "All sources" }, ...Object.entries(originNames).map(([value, label]) => ({ value, label }))]} />;

  return (
    <div
      className={`capability-panel capability-library skill-library relative ${kind === "mcp" ? "mcp-library" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
        <div className="skill-library-heading">
          <div className="skill-library-context">
            <h1>{kind === "mcp" ? (zh ? "MCP 服务" : "MCP servers") : (zh ? "Skills 技能" : "Skills")}</h1>
            {harness}
            <span className="skill-library-count">{zh ? `${enabledCount} / ${inventory.length} 已启用` : `${enabledCount} / ${inventory.length} enabled`}</span>
          </div>
          {actions}
        </div>
        <div className="skill-library-toolbar">
          <div className="capability-underline-tabs" role="group" aria-label={zh ? "启用状态" : "Enabled status"}>
            {filters.map(({ id, label, count }) => <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}>
              {label}<span>{count}</span>
            </button>)}
          </div>
          <div className="skill-library-filters">{search}{sourceSelect}</div>
        </div>
      <ResourceSyncDialog kind={kind} open={syncOpen} onOpenChange={setSyncOpen}/>
      {loadError && tools.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-5 py-10 text-center">
          <p className="text-sm font-medium text-ink">
            {t("agents.tools.loadFailed")}
          </p>
          <p className="text-xs text-ink-3">{loadError}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t("common.retry")}
          </Button>
        </Card>
      ) : !loaded || (loading && tools.length === 0) ? (
        <Card className="px-5 py-10 text-center text-sm text-ink-3">
          {t("common.loading")}
        </Card>
      ) : kind === "mcp" ? (
        <McpWorkbench
          groups={groups}
          originNames={originNames}
          hasServers={inventory.length > 0}
          onCreate={openCreate}
          onEdit={openEdit}
          onDelete={setDeleting}
          renderSwitch={(tool) => <Switch
            checked={capabilityEnabledFor(tool, daemonProviderId)}
            disabled={!providerId || toggling.includes(tool.id)}
            onCheckedChange={(checked) => handleToggle(tool, checked)}
            aria-label={`${harnessName} · ${tool.name}`}
          />}
        />
      ) : inventory.length === 0 ? (
        <EmptyState
          icon={Blocks}
          title={t("agents.tools.emptyTitle")}
          description={t("agents.tools.emptyDesc")}
          action={
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" aria-hidden />{" "}
              {zh ? "添加 Skill" : "Add Skill"}
            </Button>
          }
        />
      ) : (
        <>
          <div className="capability-library-groups">
            {groups.map(group => <section key={group.origin} aria-label={originNames[group.origin]}>
              <div className="capability-group-heading"><h3>{originNames[group.origin]}</h3><span>{group.items.length}</span></div>
              <div className="capability-group-list">
                {group.items.map(tool => {
                  const origin = capabilityOrigin(tool);
                  const description = capabilityDescription(tool);
                  const enabled = capabilityEnabledFor(tool, daemonProviderId);
                  return <article key={tool.id} className="skill-library-card" data-enabled={enabled}>
                    <button type="button" className="skill-card-open" onClick={() => setEditor({ mode: "view", capability: tool })} aria-label={`${zh ? "查看详情" : "View details"} · ${tool.name}`}>
                      <span className="skill-card-heading">
                        <strong title={tool.name}>{tool.name}</strong>
                        {origin.kind !== "builtin" && origin.label && <span className="skill-card-origin" title={origin.label}>{origin.label}</span>}
                      </span>
                      <span className="skill-card-description" data-empty={!description} title={description || undefined}>
                        {description || (zh ? "暂无说明" : "No description")}
                      </span>
                    </button>
                    <Switch checked={enabled} disabled={!providerId || toggling.includes(tool.id)} onCheckedChange={checked => handleToggle(tool, checked)} aria-label={`${harnessName} · ${tool.name}`} />
                  </article>;
                })}
              </div>
            </section>)}
          </div>
          {filtered.length === 0 && (
            <Card className="px-5 py-10 text-center text-sm text-ink-3">
              {view === "enabled" && !query && sourceFilter === "all" ? <><p>{zh ? `${harnessName} 还没有启用技能。` : `Nothing is enabled for ${harnessName} yet.`}</p><button className="mt-3 text-ink underline underline-offset-4" onClick={() => setView("all")}>{zh ? "浏览全部" : "Browse all"}</button></> : t("agents.tools.emptyFiltered")}
            </Card>
          )}
        </>
      )}

      <CapabilityEditorDialog
        state={editor}
        onChange={setEditor}
        onRemove={(tool) => {
          setDeleting(tool);
          setEditor(undefined);
        }}
        originNames={originNames}
        defaultKind={kind}
        defaultProviderId={providerId}
      />

      <CapabilityImportDialog
        open={importOpen}
        onOpenChange={(open) => {
          setImportOpen(open);
          if (!open) setImportSeed(undefined);
        }}
        seed={importSeed}
        defaultProviderId={providerId}
      />

      {dropActive && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-card/70 backdrop-blur-[2px]">
          <div className="rounded-2xl border-2 border-dashed border-accent/50 bg-card px-8 py-6 text-center">
            <p className="text-sm font-semibold text-ink">
              {t("agents.tools.import.dropTitle")}
            </p>
            <p className="mt-1 text-xs text-ink-3">
              {t("agents.tools.import.dropDesc")}
            </p>
          </div>
        </div>
      )}

      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleting(undefined);
        }}
        title={t("agents.tools.deleteTitle")}
        description={
          deleting
            ? t("agents.tools.deleteDesc", { name: deleting.name })
            : undefined
        }
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setDeleting(undefined)}
              disabled={deleteBusy}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => void confirmDelete()}
              disabled={deleteBusy}
            >
              {t("common.remove")}
            </Button>
          </>
        }
      >
        <div />
      </Dialog>
    </div>
  );
}
