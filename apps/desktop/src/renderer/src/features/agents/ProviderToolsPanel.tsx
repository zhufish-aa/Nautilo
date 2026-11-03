import { useEffect, useMemo, useState, type DragEvent } from "react";
import {
  Blocks,
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
import { toUiProviderId } from "../../lib/core-mappers";
import { providerMeta, useProviderMetas } from "../../lib/provider-catalog";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { safeMcpSummary } from "./import-safety";
import { Input } from "../../components/ui/Input";
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

export function ProviderToolsPanel(): JSX.Element {
  const { t, locale } = useI18n();
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

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return tools.filter((tool) => {
      if (kind !== "all" && tool.kind !== kind) return false;
      if (
        providerId !== "all" &&
        !tool.providerIds.map(toUiProviderId).includes(providerId)
      )
        return false;
      if (!normalized) return true;
      return `${tool.name} ${tool.description} ${tool.tags.join(" ")}`
        .toLowerCase()
        .includes(normalized);
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
    void toggle(tool.id, enabled).catch((error: unknown) =>
      toast.error(messageOf(error)),
    );
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-ink">
          {t("agents.tools.title")}
        </h3>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => openImport()}>
            <Import className="h-4 w-4" aria-hidden />
            {t("agents.tools.import.button")}
          </Button>
          <Button variant="primary" size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("agents.tools.add")}
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
        <select
          className="h-9 rounded-lg border border-line bg-card px-3 text-sm text-ink"
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as CapabilityKind | "all")
          }
          aria-label={t("agents.tools.editor.kindLabel")}
        >
          <option value="all">{t("agents.tools.kindAll")}</option>
          <option value="skill">{t("agents.tools.kindSkill")}</option>
          <option value="mcp">MCP</option>
        </select>
        <select
          className="h-9 rounded-lg border border-line bg-card px-3 text-sm text-ink"
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
          aria-label={t("agents.tools.editor.providers")}
        >
          <option value="all">{t("agents.tools.allProviders")}</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>
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
          <div className="divide-y divide-line rounded-xl border border-line">
            {filtered.map((tool) => (
              <div
                key={tool.id}
                className="flex flex-wrap items-center gap-3 px-4 py-4"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line text-ink-2">
                  {tool.kind === "mcp" ? (
                    <Server className="h-4 w-4" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                </span>
                <div className="min-w-[140px] flex-1">
                  <h3
                    className="truncate text-sm font-medium text-ink"
                    title={tool.description}
                  >
                    {tool.name}
                  </h3>
                  <p className="mt-1 truncate text-xs text-ink-3">
                    {tool.kind === "mcp" ? "MCP" : t("agents.tools.kindSkill")}{" "}
                    ·{" "}
                    {tool.providerIds
                      .map((id) => providerMeta(toUiProviderId(id)).name)
                      .join(", ") || "—"}
                  </p>
                  {(tool.mcp || tool.tags.length > 0 || tool.skill?.source) && (
                    <details className="mt-1 text-xs text-ink-3">
                      <summary className="w-fit cursor-pointer">
                        {locale === "zh-CN" ? "详情" : "Details"}
                      </summary>
                      <p className="mt-2 break-all font-mono">
                        {tool.mcp
                          ? safeMcpSummary(tool.mcp)
                          : tool.skill?.source}
                      </p>
                      <p>{tool.tags.join(" · ")}</p>
                    </details>
                  )}
                </div>
                <Switch
                  checked={tool.enabled}
                  onCheckedChange={(checked) => handleToggle(tool, checked)}
                  aria-label={`${tool.name} ${tool.enabled ? t("common.enabled") : t("common.disabled")}`}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => openEdit(tool)}
                  aria-label={`${t("common.edit")} ${tool.name}`}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setDeleting(tool)}
                  aria-label={`${t("common.remove")} ${tool.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
          {filtered.length === 0 && (
            <Card className="px-5 py-10 text-center text-sm text-ink-3">
              {t("agents.tools.emptyFiltered")}
            </Card>
          )}
        </>
      )}

      <button
        type="button"
        onClick={() => openImport()}
        className="w-full rounded-xl border border-dashed border-line px-4 py-5 text-sm text-ink-3 transition-colors hover:bg-card-hover"
      >
        {t("agents.tools.import.dropTitle")}
      </button>

      <CapabilityEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        capability={editing}
      />

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
