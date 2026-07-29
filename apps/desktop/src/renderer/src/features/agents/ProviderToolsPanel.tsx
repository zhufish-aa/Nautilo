import { useEffect, useMemo, useState, type DragEvent } from "react";
import { Blocks, Import, Pencil, Plus, Search, Server, Sparkles, Trash2, Wrench, type LucideIcon } from "lucide-react";
import type { CapabilityKind, ProviderCapability } from "@agenthub/domain";
import { isElectron } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { toUiProviderId } from "../../lib/core-mappers";
import { providerMeta, useProviderMetas } from "../../lib/provider-catalog";
import { Button } from "../../components/ui/Button";
import { Card, MotionCard, StaggerGroup } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Input } from "../../components/ui/Input";
import { Switch } from "../../components/ui/Switch";
import { Tag, StatusChip } from "../../components/ui/Badge";
import { toast } from "../../stores/toast";
import { useProviderToolsStore } from "../../stores/provider-tools";
import { CapabilityEditorDialog } from "./CapabilityEditorDialog";
import { CapabilityImportDialog, type CapabilityImportSeed } from "./CapabilityImportDialog";

/** A dropped file can seed the wizard: .json goes to the MCP tab, .md to Skills. */
const DROP_EXTENSIONS = [".json", ".md", ".markdown"];

const PROVIDER_GRADIENTS = [
  "from-violet-500/25 to-fuchsia-500/15 text-violet-400",
  "from-amber-500/25 to-orange-500/15 text-amber-400",
  "from-sky-500/25 to-cyan-500/15 text-sky-400",
  "from-emerald-500/25 to-teal-500/15 text-emerald-400",
  "from-slate-500/25 to-gray-500/15 text-slate-400"
];

function mcpCommandLine(tool: ProviderCapability): string | undefined {
  if (tool.kind !== "mcp" || !tool.mcp) return undefined;
  if (tool.mcp.transport === "http") return tool.mcp.url;
  const line = [tool.mcp.command, ...(tool.mcp.args ?? [])].filter(Boolean).join(" ");
  return line || undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProviderToolsPanel(): JSX.Element {
  const { t } = useI18n();
  const providers = useProviderMetas();
  const tools = useProviderToolsStore((state) => state.tools);
  const loading = useProviderToolsStore((state) => state.loading);
  const loaded = useProviderToolsStore((state) => state.loaded);
  const loadError = useProviderToolsStore((state) => state.error);
  const load = useProviderToolsStore((state) => state.load);
  const toggle = useProviderToolsStore((state) => state.toggle);
  const remove = useProviderToolsStore((state) => state.remove);

  const [kind, setKind] = useState<CapabilityKind | "all">("all");
  const [providerId, setProviderId] = useState("all");
  const [query, setQuery] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderCapability | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);
  const [importSeed, setImportSeed] = useState<CapabilityImportSeed | undefined>(undefined);
  const [dropActive, setDropActive] = useState(false);
  const [deleting, setDeleting] = useState<ProviderCapability | undefined>(undefined);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    if (isElectron && !loaded) void load();
  }, [load, loaded]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return tools.filter((tool) => {
      if (kind !== "all" && tool.kind !== kind) return false;
      if (providerId !== "all" && !tool.providerIds.map(toUiProviderId).includes(providerId)) return false;
      if (!normalized) return true;
      return `${tool.name} ${tool.description} ${tool.tags.join(" ")}`.toLowerCase().includes(normalized);
    });
  }, [kind, providerId, query, tools]);

  if (!isElectron) {
    return (
      <EmptyState
        icon={Wrench}
        title={t("agents.tools.desktopOnlyTitle")}
        description={t("agents.tools.desktopOnlyDesc")}
      />
    );
  }

  const skillCount = tools.filter((tool) => tool.kind === "skill").length;
  const mcpCount = tools.filter((tool) => tool.kind === "mcp").length;
  const enabledCount = tools.filter((tool) => tool.enabled).length;
  const stats: Array<{ label: string; count: number; icon: LucideIcon }> = [
    { label: t("agents.tools.stats.skills"), count: skillCount, icon: Sparkles },
    { label: t("agents.tools.stats.mcps"), count: mcpCount, icon: Server },
    { label: t("agents.tools.stats.enabled"), count: enabledCount, icon: Blocks }
  ];

  const openCreate = (): void => {
    setEditing(undefined);
    setEditorOpen(true);
  };

  const openImport = (seed?: CapabilityImportSeed): void => {
    setImportSeed(seed);
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
        openImport({ tab: lower.endsWith(".json") ? "mcp" : "skills", text, fileName: file.name })
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
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropActive(false);
  };

  const openEdit = (tool: ProviderCapability): void => {
    setEditing(tool);
    setEditorOpen(true);
  };

  const handleToggle = (tool: ProviderCapability, enabled: boolean): void => {
    void toggle(tool.id, enabled).catch((error: unknown) => toast.error(messageOf(error)));
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
      className="relative space-y-4"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-info/25 bg-info/10 px-4 py-3">
        <div className="flex items-start gap-3">
          <Wrench className="mt-0.5 h-4.5 w-4.5 shrink-0 text-info" aria-hidden />
          <div>
            <p className="text-[13px] font-medium text-ink">{t("agents.tools.title")}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{t("agents.tools.desc")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => openImport()}>
            <Import className="h-3.5 w-3.5" aria-hidden /> {t("agents.tools.import.button")}
          </Button>
          <Button variant="primary" size="sm" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> {t("agents.tools.add")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {stats.map(({ label, count, icon: Icon }) => (
          <Card key={label} className="flex items-center gap-3 px-4 py-3">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-soft text-accent"><Icon className="h-4 w-4" aria-hidden /></span>
            <div><p className="text-xs text-ink-3">{label}</p><p className="text-lg font-semibold text-ink">{count}</p></div>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("agents.tools.searchPlaceholder")} className="pl-9" aria-label={t("agents.tools.searchPlaceholder")} />
        </div>
        <div className="inline-flex rounded-xl border border-line bg-card p-1" role="tablist" aria-label={t("agents.tools.editor.kindLabel")}>
          {(["all", "skill", "mcp"] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={kind === value} onClick={() => setKind(value)} className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${kind === value ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink"}`}>
              {value === "all" ? t("agents.tools.kindAll") : value === "skill" ? t("agents.tools.kindSkill") : t("agents.tools.kindMcp")}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2" role="list" aria-label={t("agents.tools.editor.providers")}>
        <button type="button" onClick={() => setProviderId("all")} className={`rounded-full border px-3 py-1 text-xs transition-colors ${providerId === "all" ? "border-accent/40 bg-accent-soft text-accent" : "border-line bg-card text-ink-3 hover:text-ink"}`}>{t("agents.tools.allProviders")}</button>
        {providers.map((provider, index) => (
          <button key={provider.id} type="button" onClick={() => setProviderId(provider.id)} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${providerId === provider.id ? "border-accent/40 bg-accent-soft text-accent" : "border-line bg-card text-ink-3 hover:text-ink"}`}>
            <span className={`grid h-4 w-4 place-items-center rounded bg-gradient-to-br font-mono text-[9px] font-semibold ${PROVIDER_GRADIENTS[index % PROVIDER_GRADIENTS.length]}`}>{provider.name.slice(0, 1)}</span>{provider.name}
          </button>
        ))}
      </div>

      {loadError && tools.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-5 py-10 text-center">
          <p className="text-sm font-medium text-ink">{t("agents.tools.loadFailed")}</p>
          <p className="text-xs text-ink-3">{loadError}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>{t("common.retry")}</Button>
        </Card>
      ) : !loaded || (loading && tools.length === 0) ? (
        <Card className="px-5 py-10 text-center text-sm text-ink-3">{t("common.loading")}</Card>
      ) : tools.length === 0 ? (
        <EmptyState
          icon={Blocks}
          title={t("agents.tools.emptyTitle")}
          description={t("agents.tools.emptyDesc")}
          action={
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" aria-hidden /> {t("agents.tools.add")}
            </Button>
          }
        />
      ) : (
        <>
          <StaggerGroup className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {filtered.map((tool) => {
              const isMcp = tool.kind === "mcp";
              const commandLine = mcpCommandLine(tool);
              return (
                <MotionCard key={tool.id} className="flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-line bg-gradient-to-br ${isMcp ? "from-cyan-500/20 to-blue-500/15 text-cyan-400" : "from-fuchsia-500/20 to-violet-500/15 text-fuchsia-400"}`}>
                        {isMcp ? <Server className="h-4 w-4" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
                      </span>
                      <div className="min-w-0"><h3 className="truncate text-sm font-semibold text-ink">{tool.name}</h3><p className="mt-0.5 text-xs text-ink-3">{tool.description}</p></div>
                    </div>
                    <Switch checked={tool.enabled} onCheckedChange={(checked) => handleToggle(tool, checked)} aria-label={`${tool.name} ${tool.enabled ? t("common.enabled") : t("common.disabled")}`} />
                  </div>
                  {commandLine && <code className="truncate rounded-lg border border-line bg-card-hover px-2.5 py-1.5 font-mono text-[11px] text-ink-2" title={commandLine}>{commandLine}</code>}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {tool.providerIds.map((daemonId) => <Tag key={daemonId} label={providerMeta(toUiProviderId(daemonId)).name} />)}
                    <Tag label={isMcp ? t("agents.tools.typeMcp") : t("agents.tools.typeSkill")} className={isMcp ? "border-info/25 bg-info/10 text-info" : "border-accent/25 bg-accent-soft text-accent"} />
                    {tool.skill?.source && <Tag label={tool.skill.source} />}
                    {tool.tags.map((tag) => <Tag key={tag} label={`#${tag}`} />)}
                  </div>
                  <div className="mt-auto flex items-center justify-between border-t border-line pt-3">
                    <StatusChip tone={tool.enabled ? "ok" : "muted"} label={tool.enabled ? t("agents.tools.running") : t("agents.tools.stopped")} />
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(tool)} aria-label={`${t("common.edit")} ${tool.name}`}>
                        <Pencil className="h-4 w-4 text-ink-3" aria-hidden />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDeleting(tool)} aria-label={`${t("common.remove")} ${tool.name}`}>
                        <Trash2 className="h-4 w-4 text-ink-3" aria-hidden />
                      </Button>
                    </div>
                  </div>
                </MotionCard>
              );
            })}
          </StaggerGroup>
          {filtered.length === 0 && <Card className="px-5 py-10 text-center text-sm text-ink-3">{t("agents.tools.emptyFiltered")}</Card>}
        </>
      )}

      <CapabilityEditorDialog open={editorOpen} onOpenChange={setEditorOpen} capability={editing} />

      <CapabilityImportDialog
        open={importOpen}
        onOpenChange={(open) => {
          setImportOpen(open);
          if (!open) setImportSeed(undefined);
        }}
        seed={importSeed}
      />

      {dropActive && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-card/70 backdrop-blur-[2px]">
          <div className="rounded-2xl border-2 border-dashed border-accent/50 bg-card px-8 py-6 text-center">
            <p className="text-sm font-semibold text-ink">{t("agents.tools.import.dropTitle")}</p>
            <p className="mt-1 text-xs text-ink-3">{t("agents.tools.import.dropDesc")}</p>
          </div>
        </div>
      )}

      <Dialog
        open={!!deleting}
        onOpenChange={(open) => { if (!open && !deleteBusy) setDeleting(undefined); }}
        title={t("agents.tools.deleteTitle")}
        description={deleting ? t("agents.tools.deleteDesc", { name: deleting.name }) : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(undefined)} disabled={deleteBusy}>{t("common.cancel")}</Button>
            <Button variant="danger" onClick={() => void confirmDelete()} disabled={deleteBusy}>{t("common.remove")}</Button>
          </>
        }
      >
        <div />
      </Dialog>
    </div>
  );
}
