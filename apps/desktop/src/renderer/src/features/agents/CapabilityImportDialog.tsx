import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { AlertTriangle, Check, FileUp, FolderOpen, RefreshCw } from "lucide-react";
import type { ProviderCapability } from "@agenthub/domain";
import type {
  CapabilityImportConflictPolicy,
  CapabilityImportPreview,
  CapabilityScanResult,
  DiscoveredMcpSource,
  McpCandidate,
  SkillCandidate
} from "@agenthub/schemas";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { toDaemonProviderId } from "../../lib/core-mappers";
import { applyTemplateFields, MCP_TEMPLATES, templateReady } from "../../lib/mcp-templates";
import { useProviderMetas } from "../../lib/provider-catalog";
import { cn } from "../../lib/utils";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Textarea } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { TabBar } from "../../components/ui/Tabs";
import { Tag } from "../../components/ui/Badge";
import { useProviderToolsStore } from "../../stores/provider-tools";
import { toast } from "../../stores/toast";

/** Text handed to the dialog from outside, e.g. a file dropped on the list page. */
export interface CapabilityImportSeed {
  tab: ImportTab;
  text: string;
  fileName?: string;
}

type ImportTab = "mcp" | "skills";
type McpSource = "template" | "paste" | "command" | "scan";
type SkillSource = "file" | "dir";

/** Directories the supported CLIs keep skills in; `~` is expanded daemon-side. */
const SKILL_DIR_PRESETS = [
  { dir: "~/.claude/skills", label: "claude skills" },
  { dir: "~/.kimi-code/skills", label: "kimi skills" },
  { dir: "~/.codex/prompts", label: "codex prompts" },
  // Codex plugin caches — each holds `<plugin>/<version>/skills/<name>/SKILL.md`.
  { dir: "~/.codex/plugins/cache/openai-curated", label: "codex curated" },
  { dir: "~/.codex/plugins/cache/openai-curated-remote", label: "codex remote" },
  { dir: "~/.codex/plugins/cache/openai-bundled", label: "codex bundled" },
  { dir: "~/.codex/plugins/cache/openai-primary-runtime", label: "codex runtime" }
];

const PARSE_DEBOUNCE_MS = 250;

/** One importable entry in the shared preview table. */
interface PreviewRow {
  key: string;
  kind: "mcp" | "skill";
  name: string;
  /** Command line or description, shown under the name. */
  detail: string;
  warnings: string[];
  origin?: string;
  exists: boolean;
  /** True when the source named its own providers, so the batch choice is optional. */
  carriesProviders: boolean;
  build: (providerIds: string[], now: string) => ProviderCapability;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandLineOf(candidate: McpCandidate): string {
  if (candidate.mcp.transport === "http") return candidate.mcp.url ?? "";
  return [candidate.mcp.command, ...(candidate.mcp.args ?? [])].filter(Boolean).join(" ");
}

function mcpRow(candidate: McpCandidate, key: string, exists: boolean): PreviewRow {
  return {
    key,
    kind: "mcp",
    name: candidate.name,
    detail: commandLineOf(candidate),
    warnings: candidate.warnings,
    origin: candidate.origin,
    exists,
    carriesProviders: false,
    build: (providerIds, now) => ({
      id: crypto.randomUUID(),
      kind: "mcp",
      name: candidate.name,
      description: candidate.description,
      tags: candidate.tags,
      enabled: candidate.enabled,
      providerIds,
      mcp: candidate.mcp,
      createdAt: now,
      updatedAt: now
    })
  };
}

function skillRow(candidate: SkillCandidate, key: string, exists: boolean): PreviewRow {
  return {
    key,
    kind: "skill",
    name: candidate.name,
    detail: candidate.description,
    warnings: candidate.warnings,
    origin: candidate.origin,
    // An AgentHub marker means we wrote this file, so it is an update either way.
    exists: exists || !!candidate.existingId,
    carriesProviders: candidate.providerIds.length > 0,
    build: (providerIds, now) => ({
      id: candidate.existingId ?? crypto.randomUUID(),
      kind: "skill",
      name: candidate.name,
      description: candidate.description,
      tags: candidate.tags,
      enabled: candidate.enabled,
      // Frontmatter providers are already daemon ids and outrank the batch choice.
      providerIds: candidate.providerIds.length > 0 ? candidate.providerIds : providerIds,
      skill: {
        instructions: candidate.instructions,
        ...(candidate.source ? { source: candidate.source } : {}),
        // Scanned `<dir>/SKILL.md` skills carry their resources along on sync.
        ...(candidate.resourceDir ? { resourceDir: candidate.resourceDir } : {})
      },
      createdAt: now,
      updatedAt: now
    })
  };
}

/** Batch importer for MCP servers and skills, shared by every entry point. */
export function CapabilityImportDialog({
  open,
  onOpenChange,
  seed
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seed?: CapabilityImportSeed;
}): JSX.Element {
  const { t } = useI18n();
  const providers = useProviderMetas();
  const tools = useProviderToolsStore((state) => state.tools);
  const parseImport = useProviderToolsStore((state) => state.parseImport);
  const discoverMcp = useProviderToolsStore((state) => state.discoverMcp);
  const scanSkills = useProviderToolsStore((state) => state.scanSkills);
  const importMany = useProviderToolsStore((state) => state.importMany);

  const [tab, setTab] = useState<ImportTab>("mcp");
  const [mcpSource, setMcpSource] = useState<McpSource>("template");
  const [skillSource, setSkillSource] = useState<SkillSource>("file");

  const [pasteText, setPasteText] = useState("");
  const [commandText, setCommandText] = useState("");
  const [skillText, setSkillText] = useState("");
  const [skillFileName, setSkillFileName] = useState<string | undefined>(undefined);

  const [picked, setPicked] = useState<string[]>([]);
  const [templateValues, setTemplateValues] = useState<Record<string, Record<number, string>>>({});

  const [parsed, setParsed] = useState<CapabilityImportPreview | undefined>(undefined);
  const [parseError, setParseError] = useState<string | undefined>(undefined);

  const [sources, setSources] = useState<DiscoveredMcpSource[]>([]);
  const [discovering, setDiscovering] = useState(false);

  const [scanDir, setScanDir] = useState("");
  const [scan, setScan] = useState<CapabilityScanResult | undefined>(undefined);
  const [scanning, setScanning] = useState(false);

  /** Rows start selected; only explicit un-checks are tracked. */
  const [deselected, setDeselected] = useState<string[]>([]);
  const [providerIds, setProviderIds] = useState<string[]>([]);
  const [conflict, setConflict] = useState<CapabilityImportConflictPolicy>("skip");
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setPasteText(seed?.tab === "mcp" ? seed.text : "");
    setCommandText("");
    setSkillText(seed?.tab === "skills" ? seed.text : "");
    setSkillFileName(seed?.tab === "skills" ? seed.fileName : undefined);
    setTab(seed?.tab ?? "mcp");
    setMcpSource(seed?.tab === "mcp" ? "paste" : "template");
    setSkillSource("file");
    setPicked([]);
    setParsed(undefined);
    setParseError(undefined);
    setScan(undefined);
    setScanDir("");
    setDeselected([]);
    setConflict("skip");
    setBusy(false);
  }, [open, seed]);

  // Only these sources parse free text; templates and scans produce rows directly.
  const parseSource = tab === "mcp"
    ? mcpSource === "paste" ? "mcpJson" : mcpSource === "command" ? "mcpCommand" : undefined
    : skillSource === "file" ? "skillMarkdown" : undefined;
  const parseText = parseSource === "mcpJson" ? pasteText : parseSource === "mcpCommand" ? commandText : skillText;
  const parseFileName = parseSource === "skillMarkdown" ? skillFileName : undefined;

  useEffect(() => {
    if (!parseSource || !parseText.trim()) {
      setParsed(undefined);
      setParseError(undefined);
      return;
    }
    let cancelled = false;
    // The daemon opens a fresh pipe connection per request, so never per keystroke.
    const timer = setTimeout(() => {
      void parseImport({ source: parseSource, text: parseText, fileName: parseFileName })
        .then((preview) => {
          if (cancelled) return;
          setParsed(preview);
          setParseError(undefined);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setParsed(undefined);
          setParseError(messageOf(error));
        });
    }, PARSE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [parseFileName, parseImport, parseSource, parseText]);

  const runDiscover = (): void => {
    setDiscovering(true);
    void discoverMcp()
      .then(setSources)
      .catch((error: unknown) => toast.error(messageOf(error)))
      .finally(() => setDiscovering(false));
  };

  useEffect(() => {
    if (open && tab === "mcp" && mcpSource === "scan" && sources.length === 0 && !discovering) runDiscover();
    // Discovery is idempotent and cheap; re-running it on every dep change is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, mcpSource]);

  const runScan = (dir: string): void => {
    if (!dir.trim()) return;
    setScanning(true);
    void scanSkills(dir)
      .then(setScan)
      .catch((error: unknown) => toast.error(messageOf(error)))
      .finally(() => setScanning(false));
  };

  const pickScanDir = async (): Promise<void> => {
    const dir = await getBridge()?.dialog.pickDirectory();
    if (!dir) return;
    setScanDir(dir);
    runScan(dir);
  };

  const onSkillFileChosen = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Allow re-picking the same file.
    event.target.value = "";
    if (!file) return;
    void file
      .text()
      .then((text) => {
        setSkillText(text);
        setSkillFileName(file.name);
      })
      .catch((error: unknown) => toast.error(messageOf(error)));
  };

  const existingKeys = useMemo(
    () => new Set(tools.map((tool) => `${tool.kind}:${tool.name.trim().toLowerCase()}`)),
    [tools]
  );
  const taken = (kind: "mcp" | "skill", name: string): boolean =>
    existingKeys.has(`${kind}:${name.trim().toLowerCase()}`);

  const rows = useMemo<PreviewRow[]>(() => {
    if (tab === "skills") {
      const skills = skillSource === "file" ? (parsed?.skills ?? []) : (scan?.skills ?? []);
      return skills.map((skill, index) => skillRow(skill, `skill:${index}`, taken("skill", skill.name)));
    }
    if (mcpSource === "template") {
      return MCP_TEMPLATES.filter(
        (template) => picked.includes(template.id) && templateReady(template, templateValues[template.id] ?? {})
      ).map((template) =>
        mcpRow(
          {
            name: template.name,
            description: t(template.descriptionKey),
            tags: template.tags,
            mcp: applyTemplateFields(template, templateValues[template.id] ?? {}),
            enabled: true,
            warnings: []
          },
          `template:${template.id}`,
          taken("mcp", template.name)
        )
      );
    }
    if (mcpSource === "scan") {
      return sources.flatMap((source) =>
        source.servers.map((server, index) =>
          mcpRow({ ...server, origin: source.label }, `scan:${source.id}:${index}`, taken("mcp", server.name))
        )
      );
    }
    return (parsed?.mcpServers ?? []).map((server, index) =>
      mcpRow(server, `mcp:${index}`, taken("mcp", server.name))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingKeys, mcpSource, parsed, picked, scan, skillSource, sources, t, tab, templateValues]);

  const selectedRows = rows.filter((row) => !deselected.includes(row.key));
  const errors = [
    ...(parseError ? [parseError] : []),
    ...(tab === "skills" && skillSource === "dir" ? (scan?.errors ?? []) : (parsed?.errors ?? []))
  ];

  const toggleRow = (key: string): void =>
    setDeselected((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));

  const toggleAll = (): void =>
    setDeselected((prev) => (prev.length === 0 ? rows.map((row) => row.key) : []));

  const toggleProvider = (providerId: string): void =>
    setProviderIds((prev) =>
      prev.includes(providerId) ? prev.filter((id) => id !== providerId) : [...prev, providerId]
    );

  const switchTab = (next: ImportTab): void => {
    setTab(next);
    setDeselected([]);
  };

  const switchMcpSource = (next: McpSource): void => {
    setMcpSource(next);
    setDeselected([]);
  };

  const switchSkillSource = (next: SkillSource): void => {
    setSkillSource(next);
    setDeselected([]);
  };

  // Rows that bring their own providers do not need the batch selection.
  const needsProvider = providerIds.length === 0 && selectedRows.some((row) => !row.carriesProviders);

  const submit = async (): Promise<void> => {
    const now = new Date().toISOString();
    const daemonIds = providerIds.map(toDaemonProviderId);
    setBusy(true);
    try {
      const results = await importMany(
        selectedRows.map((row) => row.build(daemonIds, now)),
        conflict
      );
      const count = (status: string): number => results.filter((result) => result.status === status).length;
      toast.success(
        t("agents.tools.import.resultToast", {
          created: count("created"),
          updated: count("updated"),
          skipped: count("skipped")
        })
      );
      const failed = results.filter((result) => result.status === "failed");
      if (failed.length > 0) {
        toast.error(t("agents.tools.import.resultFailed", { count: failed.length, reason: failed[0].error ?? "" }));
        return;
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
      title={t("agents.tools.import.title")}
      description={t("agents.tools.import.desc")}
      widthClass="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={busy || selectedRows.length === 0 || needsProvider}
          >
            {busy ? t("agents.tools.import.importing") : t("agents.tools.import.submit", { count: selectedRows.length })}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TabBar
          aria-label={t("agents.tools.import.title")}
          value={tab}
          onValueChange={(value) => switchTab(value as ImportTab)}
          items={[
            { value: "mcp", label: t("agents.tools.import.tabMcp") },
            { value: "skills", label: t("agents.tools.import.tabSkills") }
          ]}
        />

        {tab === "mcp" ? (
          <div className="space-y-3">
            <TabBar
              aria-label={t("agents.tools.import.tabMcp")}
              value={mcpSource}
              onValueChange={(value) => switchMcpSource(value as McpSource)}
              items={[
                { value: "template", label: t("agents.tools.import.sourceTemplate") },
                { value: "paste", label: t("agents.tools.import.sourcePaste") },
                { value: "command", label: t("agents.tools.import.sourceCommand") },
                { value: "scan", label: t("agents.tools.import.sourceScan") }
              ]}
            />

            {mcpSource === "template" && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {MCP_TEMPLATES.map((template) => {
                  const active = picked.includes(template.id);
                  const values = templateValues[template.id] ?? {};
                  return (
                    <div
                      key={template.id}
                      className={cn(
                        "rounded-xl border p-3 transition-colors",
                        active ? "border-accent/40 bg-accent-soft/40" : "border-line bg-card"
                      )}
                    >
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={active}
                        onClick={() =>
                          setPicked((prev) =>
                            prev.includes(template.id)
                              ? prev.filter((id) => id !== template.id)
                              : [...prev, template.id]
                          )
                        }
                        className="flex w-full items-start gap-2.5 text-left"
                      >
                        <span
                          className={cn(
                            "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border",
                            active ? "border-accent bg-accent text-white" : "border-line-strong"
                          )}
                        >
                          {active && <Check className="h-3 w-3" aria-hidden />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium text-ink">{template.name}</span>
                          <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">
                            {t(template.descriptionKey)}
                          </span>
                        </span>
                      </button>
                      {active &&
                        template.fields?.map((field) => (
                          <div key={field.argIndex} className="mt-2.5">
                            <Field label={t(field.labelKey)}>
                              <Input
                                value={values[field.argIndex] ?? ""}
                                onChange={(event) =>
                                  setTemplateValues((prev) => ({
                                    ...prev,
                                    [template.id]: { ...(prev[template.id] ?? {}), [field.argIndex]: event.target.value }
                                  }))
                                }
                                placeholder={field.placeholder}
                                spellCheck={false}
                                className="font-mono text-[13px]"
                              />
                            </Field>
                          </div>
                        ))}
                      {active && !templateReady(template, values) && (
                        <p className="mt-1.5 text-xs text-warn">{t("agents.tools.import.templateFill")}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {mcpSource === "paste" && (
              <Field label={t("agents.tools.import.pasteLabel")} htmlFor="import-paste">
                <Textarea
                  id="import-paste"
                  autoFocus
                  rows={10}
                  value={pasteText}
                  onChange={(event) => setPasteText(event.target.value)}
                  placeholder={t("agents.tools.import.pastePlaceholder")}
                  spellCheck={false}
                  className="font-mono text-[13px] leading-relaxed"
                />
              </Field>
            )}

            {mcpSource === "command" && (
              <Field
                label={t("agents.tools.import.commandLabel")}
                htmlFor="import-command"
                hint={t("agents.tools.import.commandHint")}
              >
                <Textarea
                  id="import-command"
                  autoFocus
                  rows={3}
                  value={commandText}
                  onChange={(event) => setCommandText(event.target.value)}
                  placeholder={t("agents.tools.import.commandPlaceholder")}
                  spellCheck={false}
                  className="font-mono text-[13px]"
                />
              </Field>
            )}

            {mcpSource === "scan" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-ink-3">
                    {discovering ? t("agents.tools.import.discovering") : t("agents.tools.import.sourceScan")}
                  </p>
                  <Button variant="outline" size="sm" onClick={runDiscover} disabled={discovering}>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {t("agents.tools.import.rescan")}
                  </Button>
                </div>
                <div className="space-y-1.5">
                  {sources.map((source) => (
                    <div
                      key={source.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-ink">{source.label}</p>
                        <p className="truncate font-mono text-[11px] text-ink-3" title={source.path}>
                          {source.path}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-ink-3">
                        {!source.available
                          ? t("agents.tools.import.sourceMissing")
                          : source.error
                            ? source.error
                            : source.servers.length === 0
                              ? t("agents.tools.import.sourceEmpty")
                              : source.servers.length}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <TabBar
              aria-label={t("agents.tools.import.tabSkills")}
              value={skillSource}
              onValueChange={(value) => switchSkillSource(value as SkillSource)}
              items={[
                { value: "file", label: t("agents.tools.import.sourceFile") },
                { value: "dir", label: t("agents.tools.import.sourceDir") }
              ]}
            />

            {skillSource === "file" ? (
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                    <FileUp className="h-3.5 w-3.5" aria-hidden /> {t("agents.tools.import.chooseFile")}
                  </Button>
                  {skillFileName && <span className="text-xs text-ink-3">{skillFileName}</span>}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".md,.markdown"
                    className="hidden"
                    tabIndex={-1}
                    aria-hidden
                    onChange={onSkillFileChosen}
                  />
                </div>
                <Field
                  label={t("agents.tools.import.skillLabel")}
                  htmlFor="import-skill"
                  hint={t("agents.tools.import.skillHint")}
                >
                  <Textarea
                    id="import-skill"
                    rows={10}
                    value={skillText}
                    onChange={(event) => {
                      setSkillText(event.target.value);
                      setSkillFileName(undefined);
                    }}
                    placeholder={t("agents.tools.import.skillPlaceholder")}
                    spellCheck={false}
                    className="font-mono text-[13px] leading-relaxed"
                  />
                </Field>
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <Input
                    value={scanDir}
                    onChange={(event) => setScanDir(event.target.value)}
                    placeholder={SKILL_DIR_PRESETS[0].dir}
                    spellCheck={false}
                    aria-label={t("agents.tools.import.sourceDir")}
                    className="font-mono text-[13px]"
                  />
                  <Button variant="outline" size="sm" onClick={() => void pickScanDir()} disabled={scanning}>
                    <FolderOpen className="h-3.5 w-3.5" aria-hidden /> {t("agents.tools.import.chooseDir")}
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => runScan(scanDir)} disabled={scanning || !scanDir.trim()}>
                    {scanning ? t("agents.tools.import.scanning") : t("agents.tools.import.rescan")}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-ink-3">{t("agents.tools.import.presetDirs")}</span>
                  {SKILL_DIR_PRESETS.map((preset) => (
                    <button
                      key={preset.dir}
                      type="button"
                      title={preset.dir}
                      onClick={() => {
                        setScanDir(preset.dir);
                        runScan(preset.dir);
                      }}
                      className="rounded-full border border-line bg-card px-2.5 py-1 font-mono text-[11px] text-ink-3 transition-colors hover:text-ink"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                {scan && (
                  <p className="text-xs text-ink-3">
                    {t("agents.tools.import.scanned", { count: scan.scannedFiles })}
                    {scan.truncated && ` · ${t("agents.tools.import.truncated")}`}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {errors.length > 0 && (
          <div
            role="alert"
            className="space-y-1 rounded-xl border border-danger/25 bg-danger/10 px-3.5 py-2.5 text-xs leading-relaxed text-danger"
          >
            {errors.map((error) => (
              <p key={error}>{error}</p>
            ))}
          </div>
        )}

        <div className="space-y-2 rounded-xl border border-line bg-card-hover/50 p-3.5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] font-medium text-ink-2">
              {t("agents.tools.import.previewTitle")}
              {rows.length > 0 && <span className="ml-1.5 text-ink-3">{rows.length}</span>}
            </p>
            {rows.length > 0 && (
              <Button variant="ghost" size="sm" onClick={toggleAll}>
                {t("agents.tools.import.selectAll")}
              </Button>
            )}
          </div>

          {rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-ink-3">{t("agents.tools.import.previewEmpty")}</p>
          ) : (
            <ul className="space-y-1.5">
              {rows.map((row) => {
                const checked = !deselected.includes(row.key);
                return (
                  <li key={row.key}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      onClick={() => toggleRow(row.key)}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
                        checked ? "border-accent/30 bg-card" : "border-line bg-card/40 opacity-60"
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border",
                          checked ? "border-accent bg-accent text-white" : "border-line-strong"
                        )}
                      >
                        {checked && <Check className="h-3 w-3" aria-hidden />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[13px] font-medium text-ink">{row.name}</span>
                          {row.exists && (
                            <Tag
                              label={t("agents.tools.import.badgeExists")}
                              className="border-warn/25 bg-warn/10 text-warn"
                            />
                          )}
                          {row.origin && <Tag label={row.origin} />}
                        </span>
                        {row.detail && (
                          <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-3" title={row.detail}>
                            {row.detail}
                          </span>
                        )}
                        {row.warnings.map((warning) => (
                          <span key={warning} className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-warn">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                            {warning}
                          </span>
                        ))}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <Field
          label={t("agents.tools.import.providersLabel")}
          hint={needsProvider ? undefined : t("agents.tools.import.providersHint")}
          error={needsProvider ? t("agents.tools.import.needProvider") : undefined}
        >
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("agents.tools.import.providersLabel")}>
            {providers.map((provider) => {
              const active = providerIds.includes(provider.id);
              return (
                <button
                  key={provider.id}
                  type="button"
                  role="checkbox"
                  aria-checked={active}
                  onClick={() => toggleProvider(provider.id)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
                    "focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none",
                    active ? "border-accent/40 bg-accent-soft text-accent" : "border-line bg-card text-ink-3 hover:text-ink"
                  )}
                >
                  {active && <Check className="h-3 w-3" aria-hidden />}
                  {provider.name}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label={t("agents.tools.import.conflictLabel")} className="max-w-56">
          <SelectField
            value={conflict}
            onValueChange={(value) => setConflict(value as CapabilityImportConflictPolicy)}
            aria-label={t("agents.tools.import.conflictLabel")}
            options={[
              { value: "skip", label: t("agents.tools.import.conflictSkip") },
              { value: "overwrite", label: t("agents.tools.import.conflictOverwrite") },
              { value: "rename", label: t("agents.tools.import.conflictRename") }
            ]}
          />
        </Field>
      </div>
    </Dialog>
  );
}
