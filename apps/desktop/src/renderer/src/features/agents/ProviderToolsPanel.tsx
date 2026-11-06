import { useEffect, useMemo, useState, type DragEvent } from "react";
import {
  Blocks,
  ChevronRight,
  Import,
  Pencil,
  Plus,
  Search,
  Server,
  Sparkles,
  Trash2,
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
import { safeMcpSummary } from "./import-safety";
import { Input } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { toast } from "../../stores/toast";
import { useProviderToolsStore } from "../../stores/provider-tools";
import { CapabilityEditorDialog } from "./CapabilityEditorDialog";
import {
  CapabilityImportDialog,
  type CapabilityImportSeed,
} from "./CapabilityImportDialog";

/** A dropped file can seed the wizard: .json goes to the MCP tab, .md to Skills. */
const DROP_EXTENSIONS = [".json", ".md", ".markdown"];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProviderToolsPanel({ kind = "skill" }: { kind?: CapabilityKind }): JSX.Element {
  const { t, locale } = useI18n();
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
  const [view, setView] = useState("enabled");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [detail, setDetail] = useState<ProviderCapability>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderCapability | undefined>(
    undefined,
  );
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
    setEditing(undefined);
    setEditorOpen(true);
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
    setEditing(tool);
    setEditorOpen(true);
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

  return (
    <div
      className="capability-panel capability-library relative space-y-5"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-xl font-semibold">{kind === "mcp" ? (zh ? "MCP 服务" : "MCP servers") : (zh ? "技能库" : "Skill library")}</h2>
        <p className="mt-1.5 text-[13px] text-ink-2">{zh ? `${harnessName} 已启用 ${enabledCount} 项，共 ${inventory.length} 项。` : `${enabledCount} enabled for ${harnessName} · ${inventory.length} total`}</p></div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => openImport()}>
            <Import className="h-4 w-4" aria-hidden />
            {t("agents.tools.import.button")}
          </Button>
          <Button variant="primary" size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden />
            {kind === "mcp" ? (zh ? "添加 MCP" : "Add MCP") : (zh ? "添加 Skill" : "Add skill")}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[180px] flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-3"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("agents.tools.searchPlaceholder")}
            className="pl-9"
            aria-label={t("agents.tools.searchPlaceholder")}
          />
        </div>
        <div className="capability-harness-select"><span>Harness</span><SelectField value={providerId} onValueChange={setProviderId} aria-label="Harness" options={providers.map((provider) => ({ value: provider.id, label: provider.name }))} /></div>
      </div>
      <div className="capability-library-filters">
        <div className="capability-view-tabs" role="group" aria-label={zh ? "启用状态" : "Enabled status"}>
          {[{ id: "enabled", label: zh ? "已启用" : "Enabled", count: enabledCount }, { id: "all", label: zh ? "全部" : "All", count: inventory.length }, { id: "disabled", label: zh ? "未启用" : "Disabled", count: inventory.length - enabledCount }].map(tab => <button key={tab.id} type="button" aria-pressed={view === tab.id} onClick={() => setView(tab.id)}>{tab.label}<span>{tab.count}</span></button>)}
        </div>
        <SelectField value={sourceFilter} onValueChange={setSourceFilter} aria-label={zh ? "筛选来源" : "Filter by source"} className="capability-source-filter" options={[{ value: "all", label: zh ? "所有来源" : "All sources" }, ...Object.entries(originNames).map(([value, label]) => ({ value, label }))]} />
      </div>
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
      ) : tools.length === 0 ? (
        <EmptyState
          icon={Blocks}
          title={t("agents.tools.emptyTitle")}
          description={t("agents.tools.emptyDesc")}
          action={
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" aria-hidden />{" "}
              {t("agents.tools.add")}
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
                  return <article key={tool.id} className="capability-library-row">
                    <button type="button" className="capability-row-main" onClick={() => setDetail(tool)} aria-label={`${zh ? "查看详情" : "View details"} · ${tool.name}`}>
                      <span className="capability-row-icon">{kind === "mcp" ? <Server size={18} /> : <Sparkles size={18} />}</span>
                      <span className="capability-row-copy"><span className="capability-row-title">{tool.name}</span>
                        {description && <span className="capability-row-description">{description}</span>}
                        <span className="capability-row-origin">{origin.label || originNames[origin.kind]}</span>
                      </span>
                      <ChevronRight size={15} className="capability-row-chevron" aria-hidden />
                    </button>
                    <Switch checked={capabilityEnabledFor(tool, daemonProviderId)} disabled={!providerId || toggling.includes(tool.id)} onCheckedChange={checked => handleToggle(tool, checked)} aria-label={`${harnessName} · ${tool.name}`} />
                  </article>;
                })}
              </div>
            </section>)}
          </div>
          {filtered.length === 0 && (
            <Card className="px-5 py-10 text-center text-sm text-ink-3">
              {view === "enabled" && !query && sourceFilter === "all" ? <><p>{zh ? `${harnessName} 还没有启用${kind === "skill" ? "技能" : "MCP 服务"}。` : `Nothing is enabled for ${harnessName} yet.`}</p><button className="mt-3 text-ink underline underline-offset-4" onClick={() => setView("all")}>{zh ? "浏览全部" : "Browse all"}</button></> : t("agents.tools.emptyFiltered")}
            </Card>
          )}
        </>
      )}

      <p className="capability-library-drop-hint">{t("agents.tools.import.dropTitle")}</p>

      <Dialog open={!!detail} onOpenChange={open => { if (!open) setDetail(undefined); }} title={detail?.name ?? ""} footer={<><Button variant="ghost" onClick={() => { setDeleting(detail); setDetail(undefined); }}><Trash2 size={15} />{t("common.remove")}</Button><Button variant="outline" onClick={() => { if (detail) openEdit(detail); setDetail(undefined); }}><Pencil size={15} />{t("common.edit")}</Button></>}>
        {detail && <div className="capability-detail">
          {capabilityDescription(detail) && <p>{capabilityDescription(detail)}</p>}
          <dl><div><dt>{zh ? "来源" : "Source"}</dt><dd>{originNames[capabilityOrigin(detail).kind]}{capabilityOrigin(detail).label ? ` · ${capabilityOrigin(detail).label}` : ""}</dd></div>
            {capabilityOrigin(detail).path && <div><dt>{zh ? "原始位置" : "Original location"}</dt><dd className="break-all">{capabilityOrigin(detail).path}</dd></div>}
            <div><dt>{zh ? "已启用于" : "Enabled for"}</dt><dd>{providers.filter(provider => capabilityEnabledFor(detail, toDaemonProviderId(provider.id))).map(provider => provider.name).join("、") || (zh ? "尚未启用" : "Not enabled yet")}</dd></div>
          </dl>
          {detail.mcp && <p className="break-all text-[13px]">{safeMcpSummary(detail.mcp)}</p>}
          {detail.skill && <details><summary>{zh ? "查看技能内容" : "View skill instructions"}</summary><pre>{detail.skill.instructions}</pre></details>}
        </div>}
      </Dialog>

      <CapabilityEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        capability={editing}
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
