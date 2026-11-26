import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Copy,
  Grid3x3,
  Import,
  LayoutPanelLeft,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import type { CapabilityKind, ProviderCapability } from "@agenthub/domain";
import { isElectron } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { toDaemonProviderId } from "../../lib/core-mappers";
import { capabilityEnabledFor } from "../../lib/capability-enablement";
import { capabilityOrigin, capabilityDescription, type CapabilityOriginKind } from "../../lib/capability-origin";
import { providerMeta, useProviderMetas } from "../../lib/provider-catalog";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Input } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { SlidingTabs } from "../../components/ui/SlidingTabs";
import { toast } from "../../stores/toast";
import { useProviderToolsStore } from "../../stores/provider-tools";
import { useAgentsStore } from "../../stores/agents";
import { CapabilityEditorDialog, type CapabilityDialogState } from "./CapabilityEditorDialog";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { McpWorkbench } from "./McpWorkbench";
import { SkillWorkbench } from "./SkillWorkbench";
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
  const reduced = useUiReducedMotion();
  const skills = kind === "skill";
  const [matrix, setMatrix] = useState(false);
  const installations = useAgentsStore(state => state.installations);
  const instances = useAgentsStore(state => state.instances);
  const ready = providers.filter(provider => installations.some(item => item.providerId === provider.id && item.status === "ready")
    && instances.find(item => item.configurationKind === "harness" && item.providerId === provider.id)?.enabled !== false);
  const searchRef = useRef<HTMLInputElement>(null);
  const writing = useRef(false);
  const [copyFrom, setCopyFrom] = useState("");
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

  useEffect(() => {
    if (!skills) return;
    function focusSearch(event: KeyboardEvent): void {
      if (event.key !== "/" || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey
        || event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]")
        || document.querySelector('[role="dialog"][data-state="open"]') || !searchRef.current?.getClientRects().length) return;
      event.preventDefault();
      searchRef.current.focus();
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [skills]);

  const inventory = useMemo(() => tools.filter(tool => tool.kind === kind), [tools, kind]);
  const enabledCount = inventory.filter(tool => capabilityEnabledFor(tool, daemonProviderId)).length;
  const missingCount = skills ? inventory.filter(tool => !capabilityDescription(tool)).length : 0;
  const filterView = view === "missing" && !missingCount ? "all" : view;
  const isEnabled = (tool: ProviderCapability): boolean => matrix
    ? ready.some(provider => capabilityEnabledFor(tool, toDaemonProviderId(provider.id)))
    : capabilityEnabledFor(tool, daemonProviderId);
  const filterCount = matrix ? inventory.filter(isEnabled).length : enabledCount;
  const indexTokens = skills ? inventory.reduce((sum, tool) => {
    if (!capabilityEnabledFor(tool, daemonProviderId)) return sum;
    const text = [tool.name, capabilityDescription(tool)].join(" ");
    const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
    return sum + cjk + Math.ceil((Array.from(text).length - cjk) / 4);
  }, 0) : 0;
  const originNames: Record<CapabilityOriginKind, string> = {
    builtin: zh ? "Nautilo 内置" : "Built into Nautilo",
    plugin: zh ? "来自插件" : "From plugins",
    local: zh ? "本机导入" : "Imported locally",
    custom: zh ? "手动创建" : "Created manually",
    unknown: zh ? "来源未记录" : "Source not recorded"
  };
  const normalized = query.trim().toLocaleLowerCase();
  const terms = skills ? normalized.split(/\s+/) : [normalized];
  const filtered = inventory.filter(tool => {
    const enabled = isEnabled(tool);
    if (filterView === "enabled" && !enabled || filterView === "disabled" && enabled
      || filterView === "missing" && capabilityDescription(tool)) return false;
    const origin = capabilityOrigin(tool);
    if (sourceFilter !== "all" && origin.kind !== sourceFilter) return false;
    const searchable = [tool.name, tool.description, originNames[origin.kind], origin.label, origin.path, ...tool.tags].join(" ").toLocaleLowerCase();
    return terms.every(term => searchable.includes(term));
  }).sort((a, b) => a.name.localeCompare(b.name, locale));
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

  const openEdit = (tool: ProviderCapability, focusDescription = false): void => {
    setEditor({ mode: "edit", capability: tool, focusDescription });
  };

  const handleToggle = (tool: ProviderCapability, enabled: boolean): void => {
    setToggling((ids) => [...ids, tool.id]);
    void toggle(tool.id, daemonProviderId, enabled)
      .catch((error: unknown) => toast.error(messageOf(error)))
      .finally(() => setToggling((ids) => ids.filter((id) => id !== tool.id)));
  };

  const applyBindings = async (updates: Array<{ id: string; targets: string[]; enabled: boolean }>): Promise<void> => {
    if (writing.current || !updates.length) return;
    writing.current = true;
    setToggling(updates.map(update => update.id));
    const errors: string[] = [];
    try {
      for (const { id, targets, enabled } of updates) {
        try { await toggle(id, targets, enabled); }
        catch (error) { errors.push(messageOf(error)); }
      }
      if (errors.length) toast.error(zh ? `${errors.length} 项启用设置保存失败 · ${errors[0]}` : `${errors.length} changes failed · ${errors[0]}`);
    } finally {
      writing.current = false;
      setToggling([]);
    }
  };

  const setBindings = (items: ProviderCapability[], targets: string[], enabled: boolean): void => {
    void applyBindings(items.map(tool => ({ id: tool.id, enabled,
      targets: targets.filter(provider => capabilityEnabledFor(tool, provider) !== enabled),
    })).filter(update => update.targets.length));
  };

  const copyPlan = (overwrite: boolean): void => {
    const source = toDaemonProviderId(copyFrom);
    if (!source || !daemonProviderId || source === daemonProviderId) return;
    void applyBindings(inventory.flatMap(tool => {
      const enabled = capabilityEnabledFor(tool, source);
      return (overwrite || enabled) && capabilityEnabledFor(tool, daemonProviderId) !== enabled
        ? [{ id: tool.id, targets: [daemonProviderId], enabled }] : [];
    }));
    setCopyFrom("");
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
    <Button variant="outline" size="sm" className="skill-action-sync" disabled={skills && !!toggling.length} onClick={() => setSyncOpen(true)}>
      <RefreshCw size={13} aria-hidden />{zh ? "原生同步" : "Native sync"}
    </Button>
    <Button variant="outline" size="sm" className="skill-action-import" disabled={skills && !!toggling.length} onClick={() => openImport()}>
      <Import size={14} aria-hidden />{t("agents.tools.import.button")}
    </Button>
    <Button variant="primary" size="sm" className="skill-action-create" disabled={skills && !!toggling.length} onClick={openCreate}>
      <Plus size={15} aria-hidden />{kind === "mcp" ? (zh ? "添加 MCP" : "Add MCP") : (zh ? "添加 Skill" : "Add Skill")}
    </Button>
  </div>;
  const harness = <div className="capability-harness-select">
    <ProviderAvatar providerId={providerId} size="sm" />
    <SelectField value={providerId} onValueChange={id => { setProviderId(id); setCopyFrom(""); }} aria-label="Harness"
      options={providers.map(provider => ({ value: provider.id, label: provider.name }))} />
  </div>;
  const search = <div className="capability-search relative">
    <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
    <Input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)}
      placeholder={skills ? (zh ? "搜索名称、描述、标签或来源..." : "Search names, descriptions, tags or sources...") : t("agents.tools.searchPlaceholder")}
      className={skills ? "pl-8 pr-8" : "pl-9"} aria-label={t("agents.tools.searchPlaceholder")} aria-keyshortcuts={skills ? "/" : undefined} />
    {skills && (query ? (
      <button type="button" className="skill-search-clear" onClick={() => { setQuery(""); searchRef.current?.focus(); }}
        aria-label={zh ? "清空搜索" : "Clear search"}><X size={13} aria-hidden /></button>
    ) : (
      <kbd className="skill-search-kbd" aria-hidden>/</kbd>
    ))}
  </div>;
  const filters: Array<{ id: string; label: string; count: number; warning?: boolean }> = [
    { id: "all", label: zh ? "全部" : "All", count: inventory.length },
    { id: "enabled", label: zh ? "已启用" : "Enabled", count: filterCount },
    { id: "disabled", label: zh ? "未启用" : "Disabled", count: inventory.length - filterCount },
  ];
  if (missingCount) filters.push({ id: "missing", label: zh ? "缺触发说明" : "Missing description", count: missingCount, warning: true });
  const sourceSelect = <SelectField value={sourceFilter} onValueChange={setSourceFilter}
    aria-label={zh ? "筛选来源" : "Filter by source"} className="capability-source-filter"
    options={[{ value: "all", label: zh ? "所有来源" : "All sources" }, ...Object.entries(originNames).map(([value, label]) => ({ value, label }))]} />;
  const totalSkills = inventory.length;
  const enabledPct = totalSkills ? (enabledCount / totalSkills) * 100 : 0;
  const missingDisabledCount = skills ? inventory.filter(tool => !capabilityDescription(tool) && !capabilityEnabledFor(tool, daemonProviderId)).length : 0;
  const missingPct = totalSkills ? (missingDisabledCount / totalSkills) * 100 : 0;
  const originSummary = (["builtin", "local", "plugin", "custom"] as const)
    .map(origin => {
      const count = inventory.filter(tool => capabilityOrigin(tool).kind === origin).length;
      const shortLabel = origin === "builtin" ? (zh ? "内置" : "Built-in")
        : origin === "local" ? (zh ? "本机" : "Local")
        : origin === "plugin" ? (zh ? "插件" : "Plugins")
        : (zh ? "自定义" : "Custom");
      return count > 0 ? `${shortLabel} ${count}` : "";
    })
    .filter(Boolean)
    .join(" · ");
  const onSpotlightMove = (event: ReactPointerEvent<HTMLElement>): void => {
    if (reduced) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty("--my", `${event.clientY - rect.top}px`);
  };

  return (
    <div
      className={`capability-panel capability-library skill-library relative ${kind === "mcp" ? "mcp-library" : ""}`}
      data-reduced-motion={reduced}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
        <div className="skill-library-heading">
          <div className="skill-library-context">
            <h1>{kind === "mcp" ? (zh ? "MCP 服务" : "MCP servers") : (zh ? "Skills 技能" : "Skills")}</h1>
            {skills && <div className="skill-mode" data-matrix={matrix} role="group" aria-label={zh ? "技能视图" : "Skills view"}>
              <span aria-hidden />
              <button type="button" aria-pressed={!matrix} onClick={() => setMatrix(false)}>
                <LayoutPanelLeft size={13} aria-hidden />{zh ? "工作台" : "Workbench"}
              </button>
              <button type="button" aria-pressed={matrix} onClick={() => { setCopyFrom(""); setMatrix(true); }}>
                <Grid3x3 size={13} aria-hidden />{zh ? "多 Harness 矩阵" : "Harness matrix"}
              </button>
            </div>}
            {!skills && <div className="skill-target-context">
              {harness}
              <span className="skill-library-count">{zh ? `${enabledCount} / ${inventory.length} 已启用` : `${enabledCount} / ${inventory.length} enabled`}</span>
            </div>}
          </div>
          {actions}
        </div>
        {skills && <AnimatePresence initial={false}>
          {!matrix && <motion.section
            className="skill-kpi-deck"
            key="harness-context"
            aria-label={zh ? "当前技能配置概览" : "Active skill configuration overview"}
            onPointerMove={onSpotlightMove}
            initial={reduced ? false : { opacity: 0, height: 0, marginTop: -8 }}
            animate={{ opacity: 1, height: "auto", marginTop: 0 }}
            exit={reduced ? undefined : { opacity: 0, height: 0, marginTop: -8 }}
            transition={{ duration: reduced ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="skill-kpi-deck-inner">
              <div className="skill-kpi-cell skill-kpi-harness">
                <span className="skill-kpi-label">{zh ? "目标 Harness" : "Target Harness"}</span>
                <div className="skill-kpi-controls">
                  {harness}
                  <details className="skill-copy-plan" onToggle={event => { if (!event.currentTarget.open) setCopyFrom(""); }}>
                    <summary><Copy size={12} aria-hidden />{zh ? "复制方案" : "Copy plan"}</summary>
                    <div className="skill-copy-popover" onKeyDown={event => {
                      if (event.key === "Escape") {
                        const details = event.currentTarget.closest("details");
                        details?.querySelector("summary")?.focus();
                        details?.removeAttribute("open");
                      }
                    }}>
                      <SelectField aria-label={zh ? "从 Harness 复制" : "Copy from Harness"} value={copyFrom} onValueChange={setCopyFrom}
                        placeholder={zh ? "选择来源 Harness" : "Choose source Harness"}
                        options={providers.filter(provider => provider.id !== providerId).map(provider => ({ value: provider.id, label: provider.name }))} />
                      <div>
                        <Button variant="outline" size="sm" disabled={!copyFrom || !providerId || !!toggling.length} onClick={event => { copyPlan(false); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{zh ? "合并启用项" : "Merge enabled"}</Button>
                        <Button variant="outline" size="sm" disabled={!copyFrom || !providerId || !!toggling.length} onClick={event => { copyPlan(true); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{zh ? "覆盖方案" : "Replace plan"}</Button>
                      </div>
                    </div>
                  </details>
                </div>
              </div>
              <div className="skill-kpi-cell">
                <span className="skill-kpi-label">
                  <i className="skill-metric-dot" data-active={enabledCount > 0} aria-hidden />
                  {zh ? "已启用技能" : "Enabled skills"}
                </span>
                <strong className="skill-kpi-value" data-accent={enabledCount > 0}>
                  {enabledCount}<em> / {totalSkills}</em>
                </strong>
                <div className="skill-kpi-bar" aria-hidden>
                  <span className="skill-kpi-bar-enabled" style={{ width: `${enabledPct}%` }} />
                  <span className="skill-kpi-bar-missing" style={{ width: `${missingPct}%` }} />
                </div>
                <small className="skill-kpi-sub">{originSummary || (zh ? "暂无技能记录" : "No skills yet")}</small>
              </div>
              <div className="skill-kpi-cell">
                <span className="skill-kpi-label">
                  <Sparkles size={11} className="skill-kpi-spark" aria-hidden />
                  {zh ? "索引开销估算" : "Estimated index"}
                </span>
                <strong className="skill-kpi-value" data-warn={indexTokens >= 1000}
                  title={zh ? "按已启用技能的名称和描述估算。中日韩字符约 1 Token，其他字符约 4 个计 1 Token。实际用量取决于模型。" : "Estimated from enabled names and descriptions. About one token per CJK character or four other characters. Actual counts depend on the model."}>
                  ~{indexTokens}<em> tok</em>
                </strong>
                <small className="skill-kpi-sub">
                  {missingCount > 0
                    ? (zh ? `${missingCount} 项缺少触发说明` : `${missingCount} missing description`)
                    : (zh ? "所有技能触发说明完整" : "All skill descriptions complete")}
                </small>
              </div>
            </div>
          </motion.section>}
        </AnimatePresence>}
        <div className="skill-library-toolbar">
          <SlidingTabs value={filterView} onChange={setView} items={filters} className="capability-underline-tabs" label={zh ? "启用状态" : "Enabled status"} />
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
      ) : <SkillWorkbench matrix={matrix} showWorkbench={() => setMatrix(false)} groups={groups} inventory={inventory}
        originNames={originNames} ready={ready} providers={providers} providerId={daemonProviderId} harnessName={harnessName}
        busy={!!toggling.length} setBindings={setBindings} onEdit={openEdit} onDelete={setDeleting} onCreate={openCreate} />}

      <CapabilityEditorDialog
        state={editor}
        onChange={setEditor}
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
