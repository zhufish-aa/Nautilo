import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ShieldCheck,
  FileUp,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import type { ProviderCapability } from "@agenthub/domain";
import type {
  CapabilityImportConflictPolicy,
  CapabilityImportOutcome,
  CapabilityImportPreview,
  CapabilityScanResult,
  DiscoveredMcpSource,
  McpCandidate,
  SkillCandidate,
} from "@agenthub/schemas";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { toDaemonProviderId } from "../../lib/core-mappers";
import {
  applyTemplateFields,
  MCP_TEMPLATES,
  templateReady,
} from "../../lib/mcp-templates";
import { useProviderMetas } from "../../lib/provider-catalog";
import { cn } from "../../lib/utils";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Textarea } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { TabBar } from "../../components/ui/Tabs";
import { Tag } from "../../components/ui/Badge";
import { useProviderToolsStore } from "../../stores/provider-tools";
import {
  maskedJson,
  redactConfig,
  safeMcpSummary,
  prepareImportedCapability,
  isCurrentPreview,
} from "./import-safety";
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
  {
    dir: "~/.codex/plugins/cache/openai-curated-remote",
    label: "codex remote",
  },
  { dir: "~/.codex/plugins/cache/openai-bundled", label: "codex bundled" },
  {
    dir: "~/.codex/plugins/cache/openai-primary-runtime",
    label: "codex runtime",
  },
];

const PARSE_DEBOUNCE_MS = 250;

/** One importable entry in the shared preview table. */
interface PreviewRow {
  key: string;
  kind: "mcp" | "skill";
  name: string;
  /** Command line or description, shown under the name. */
  detail: string;
  config?: McpCandidate["mcp"];
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
  return [candidate.mcp.command, ...(candidate.mcp.args ?? [])]
    .filter(Boolean)
    .join(" ");
}

function mcpRow(
  candidate: McpCandidate,
  key: string,
  exists: boolean,
): PreviewRow {
  return {
    key,
    kind: "mcp",
    name: candidate.name,
    detail: safeMcpSummary(candidate.mcp),
    config: candidate.mcp,
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
      origin: candidate.origin ? { kind: "local", path: candidate.origin } : { kind: "custom" },
      createdAt: now,
      updatedAt: now,
    }),
  };
}

function skillRow(
  candidate: SkillCandidate,
  key: string,
  exists: boolean,
): PreviewRow {
  return {
    key,
    kind: "skill",
    name: candidate.name,
    detail: candidate.description,
    warnings: candidate.warnings,
    origin: candidate.origin,
    // An Nautilo marker means we wrote this file, so it is an update either way.
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
      origin: candidate.origin ? { kind: "local", path: candidate.origin } : { kind: "custom" },
      providerIds:
        candidate.providerIds.length > 0 ? candidate.providerIds : providerIds,
      skill: {
        instructions: candidate.instructions,
        ...(candidate.source ? { source: candidate.source } : {}),
        // Scanned `<dir>/SKILL.md` skills carry their resources along on sync.
        ...(candidate.resourceDir
          ? { resourceDir: candidate.resourceDir }
          : {}),
      },
      createdAt: now,
      updatedAt: now,
    }),
  };
}

/** Batch importer for MCP servers and skills, shared by every entry point. */
export function CapabilityImportDialog({
  open,
  onOpenChange,
  seed,
  defaultProviderId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seed?: CapabilityImportSeed;
  defaultProviderId?: string;
}): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const providers = useProviderMetas();
  const tools = useProviderToolsStore((state) => state.tools);
  const parseImport = useProviderToolsStore((state) => state.parseImport);
  const discoverMcp = useProviderToolsStore((state) => state.discoverMcp);
  const scanSkills = useProviderToolsStore((state) => state.scanSkills);
  const importMany = useProviderToolsStore((state) => state.importMany);

  const [tab, setTab] = useState<ImportTab>("mcp");
  const [mcpSource, setMcpSource] = useState<McpSource>("paste");
  const [skillSource, setSkillSource] = useState<SkillSource>("file");

  const [pasteText, setPasteText] = useState("");
  const [commandText, setCommandText] = useState("");
  const [skillText, setSkillText] = useState("");
  const [skillFileName, setSkillFileName] = useState<string | undefined>(
    undefined,
  );

  const [picked, setPicked] = useState<string[]>([]);
  const [templateValues, setTemplateValues] = useState<
    Record<string, Record<number, string>>
  >({});

  const [parsed, setParsed] = useState<CapabilityImportPreview | undefined>(
    undefined,
  );
  const [parseError, setParseError] = useState<string | undefined>(undefined);

  const [sources, setSources] = useState<DiscoveredMcpSource[]>([]);
  const [discovering, setDiscovering] = useState(false);

  const [scanDir, setScanDir] = useState("");
  const [scan, setScan] = useState<CapabilityScanResult | undefined>(undefined);
  const [scanning, setScanning] = useState(false);

  /** Rows start selected; only explicit un-checks are tracked. */
  const [deselected, setDeselected] = useState<string[]>([]);
  const [providerIds, setProviderIds] = useState<string[]>([]);
  const [conflict, setConflict] =
    useState<CapabilityImportConflictPolicy>("skip");
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonFileRef = useRef<HTMLInputElement>(null);
  const sourceRevision = useRef(0);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [acceptedKey, setAcceptedKey] = useState<string>();
  const [stage, setStage] = useState<"source" | "preview" | "result">("source");
  const [results, setResults] = useState<CapabilityImportOutcome[]>([]);
  const [revealSource, setRevealSource] = useState(false);
  const [jsonFileName, setJsonFileName] = useState<string>();
  const invalidatePreview = (): void => {
    sourceRevision.current += 1;
    setPreviewRevision(sourceRevision.current);
    setParsed(undefined);
    setAcceptedKey(undefined);
    setParseError(undefined);
    setDeselected([]);
    setStage("source");
  };
  const updatePaste = (text: string): void => {
    invalidatePreview();
    setPasteText(text);
  };
  const onJsonFile = async (
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    invalidatePreview();
    setPasteText("");
    setJsonFileName(undefined);
    const revision = sourceRevision.current;
    if (file.size > 2 * 1024 * 1024) {
      setParseError(
        zh ? "JSON 文件不能超过 2 MB。" : "JSON files must be under 2 MB.",
      );
      return;
    }
    try {
      const text = await file.text();
      if (revision !== sourceRevision.current) return;
      setPasteText(text);
      setJsonFileName(file.name);
      setRevealSource(false);
      setMcpSource("paste");
    } catch {
      setParseError(zh ? "无法读取文件。" : "Could not read the file.");
    }
  };

  useEffect(() => {
    if (!open) return;
    setPasteText(seed?.tab === "mcp" ? seed.text : "");
    setCommandText("");
    setSkillText(seed?.tab === "skills" ? seed.text : "");
    setSkillFileName(seed?.tab === "skills" ? seed.fileName : undefined);
    setTab(seed?.tab ?? "mcp");
    setMcpSource("paste");
    setStage("source");
    setResults([]);
    setAcceptedKey(undefined);
    setRevealSource(false);
    setJsonFileName(seed?.fileName);
    sourceRevision.current += 1;
    setSkillSource("file");
    setPicked([]);
    setParsed(undefined);
    setParseError(undefined);
    setScan(undefined);
    setScanDir("");
    setDeselected([]);
    setConflict("skip");
    setProviderIds(defaultProviderId ? [defaultProviderId] : []);
    setBusy(false);
  }, [open, seed, defaultProviderId]);

  // Only these sources parse free text; templates and scans produce rows directly.
  const parseSource =
    tab === "mcp"
      ? mcpSource === "paste"
        ? "mcpJson"
        : mcpSource === "command"
          ? "mcpCommand"
          : undefined
      : skillSource === "file"
        ? "skillMarkdown"
        : undefined;
  const parseText =
    parseSource === "mcpJson"
      ? pasteText
      : parseSource === "mcpCommand"
        ? commandText
        : skillText;
  const parseFileName =
    parseSource === "skillMarkdown" ? skillFileName : undefined;

  useEffect(() => {
    if (!open || !parseSource || !parseText.trim()) {
      setParsed(undefined);
      setParseError(undefined);
      return;
    }
    let cancelled = false;
    const revision = sourceRevision.current;
    setParsed(undefined);
    setAcceptedKey(undefined);
    // The daemon opens a fresh pipe connection per request, so never per keystroke.
    const timer = setTimeout(() => {
      void parseImport({
        source: parseSource,
        text: parseText,
        fileName: parseFileName,
      })
        .then((preview) => {
          if (cancelled || revision !== sourceRevision.current) return;
          setParsed(preview);
          setAcceptedKey(`${parseSource}\0${parseText}`);
          setParseError(undefined);
        })
        .catch((error: unknown) => {
          if (cancelled || revision !== sourceRevision.current) return;
          setParsed(undefined);
          setParseError(
            zh
              ? "配置解析失败，请检查格式后重试。"
              : "Could not parse this configuration. Check its format and retry.",
          );
        });
    }, PARSE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    open,
    parseFileName,
    parseImport,
    parseSource,
    parseText,
    previewRevision,
  ]);

  const runDiscover = (): void => {
    setDiscovering(true);
    void discoverMcp()
      .then(setSources)
      .catch((error: unknown) =>
        toast.error(
          zh
            ? "操作失败，请检查配置后重试。"
            : "Operation failed. Check the configuration and retry.",
        ),
      )
      .finally(() => setDiscovering(false));
  };

  useEffect(() => {
    if (
      open &&
      tab === "mcp" &&
      mcpSource === "scan" &&
      sources.length === 0 &&
      !discovering
    )
      runDiscover();
    // Discovery is idempotent and cheap; re-running it on every dep change is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, mcpSource]);

  const runScan = (dir: string): void => {
    if (!dir.trim()) return;
    setScanning(true);
    void scanSkills(dir)
      .then(setScan)
      .catch((error: unknown) =>
        toast.error(
          zh
            ? "操作失败，请检查配置后重试。"
            : "Operation failed. Check the configuration and retry.",
        ),
      )
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
    invalidatePreview();
    setSkillText("");
    setSkillFileName(undefined);
    const revision = sourceRevision.current;
    void file
      .text()
      .then((text) => {
        if (revision !== sourceRevision.current) return;
        setSkillText(text);
        setSkillFileName(file.name);
      })
      .catch((error: unknown) =>
        toast.error(
          zh
            ? "操作失败，请检查配置后重试。"
            : "Operation failed. Check the configuration and retry.",
        ),
      );
  };

  const existingKeys = useMemo(
    () =>
      new Set(
        tools.map((tool) => `${tool.kind}:${tool.name.trim().toLowerCase()}`),
      ),
    [tools],
  );
  const taken = (kind: "mcp" | "skill", name: string): boolean =>
    existingKeys.has(`${kind}:${name.trim().toLowerCase()}`);

  const rows = useMemo<PreviewRow[]>(() => {
    if (tab === "skills") {
      if (parseSource && !isCurrentPreview(parseSource, parseText, acceptedKey))
        return [];
      const skills =
        skillSource === "file" ? (parsed?.skills ?? []) : (scan?.skills ?? []);
      return skills.map((skill, index) =>
        skillRow(skill, `skill:${index}`, taken("skill", skill.name)),
      );
    }
    if (mcpSource === "template") {
      return MCP_TEMPLATES.filter(
        (template) =>
          picked.includes(template.id) &&
          templateReady(template, templateValues[template.id] ?? {}),
      ).map((template) =>
        mcpRow(
          {
            name: template.name,
            description: t(template.descriptionKey),
            tags: template.tags,
            mcp: applyTemplateFields(
              template,
              templateValues[template.id] ?? {},
            ),
            enabled: true,
            warnings: [],
          },
          `template:${template.id}`,
          taken("mcp", template.name),
        ),
      );
    }
    if (mcpSource === "scan") {
      return sources.flatMap((source) =>
        source.servers.map((server, index) =>
          mcpRow(
            { ...server, origin: source.label },
            `scan:${source.id}:${index}`,
            taken("mcp", server.name),
          ),
        ),
      );
    }
    if (!isCurrentPreview(parseSource, parseText, acceptedKey)) return [];
    return (parsed?.mcpServers ?? []).map((server, index) =>
      mcpRow(server, `mcp:${index}`, taken("mcp", server.name)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    acceptedKey,
    parseSource,
    parseText,
    existingKeys,
    mcpSource,
    parsed,
    picked,
    scan,
    skillSource,
    sources,
    t,
    tab,
    templateValues,
  ]);

  const selectedRows = rows.filter((row) => !deselected.includes(row.key));
  const errors = [
    ...(parseError ? [parseError] : []),
    ...(tab === "skills" && skillSource === "dir"
      ? (scan?.errors ?? [])
      : (parsed?.errors ?? [])),
  ];

  const toggleRow = (key: string): void =>
    setDeselected((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    );

  const toggleAll = (): void =>
    setDeselected((prev) =>
      prev.length === 0 ? rows.map((row) => row.key) : [],
    );

  const toggleProvider = (providerId: string): void =>
    setProviderIds((prev) =>
      prev.includes(providerId)
        ? prev.filter((id) => id !== providerId)
        : [...prev, providerId],
    );

  const switchTab = (next: ImportTab): void => {
    invalidatePreview();
    setTab(next);
    setDeselected([]);
  };

  const switchMcpSource = (next: McpSource): void => {
    invalidatePreview();
    setMcpSource(next);
    setDeselected([]);
  };

  const switchSkillSource = (next: SkillSource): void => {
    invalidatePreview();
    setSkillSource(next);
    setDeselected([]);
  };

  // Rows that bring their own providers do not need the batch selection.
  const needsProvider =
    providerIds.length === 0 &&
    selectedRows.some((row) => !row.carriesProviders);

  const submit = async (): Promise<void> => {
    if (
      busy ||
      stage !== "preview" ||
      !isCurrentPreview(parseSource, parseText, acceptedKey) ||
      selectedRows.length === 0 ||
      needsProvider
    )
      return;
    const now = new Date().toISOString();
    const daemonIds = providerIds.map(toDaemonProviderId);
    setBusy(true);
    try {
      const results = await importMany(
        selectedRows.map((row) =>
          prepareImportedCapability({ ...row.build(daemonIds, now), ...(defaultProviderId ? { providerIds: daemonIds } : {}) }),
        ),
        conflict,
      );
      setResults(results);
      setStage("result");
      const count = (status: string): number =>
        results.filter((result) => result.status === status).length;
      toast.success(
        t("agents.tools.import.resultToast", {
          created: count("created"),
          updated: count("updated"),
          skipped: count("skipped"),
        }),
      );
      const failed = results.filter((result) => result.status === "failed");
      if (failed.length > 0) {
        toast.error(
          t("agents.tools.import.resultFailed", {
            count: failed.length,
            reason: zh ? "请检查对应配置" : "Check the configuration",
          }),
        );
        return;
      }
    } catch (error) {
      toast.error(
        zh
          ? "操作失败，请检查配置后重试。"
          : "Operation failed. Check the configuration and retry.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        if (!next) sourceRevision.current += 1;
        onOpenChange(next);
      }}
      title={tab === "mcp" ? (zh ? "导入 MCP" : "Import MCP") : (zh ? "导入技能" : "Import skills")}
      presentation="workspace"
      widthClass="capability-import-dialog"
      footer={
        <>
          <span className="import-selection-count">{zh ? `已选择 ${selectedRows.length} 项` : `${selectedRows.length} selected`}</span>
          <Button
            variant="ghost"
            onClick={() =>
              stage === "preview" ? setStage("source") : onOpenChange(false)
            }
            disabled={busy}
          >
            {stage === "preview"
              ? zh
                ? "上一步"
                : "Back"
              : stage === "result"
                ? t("common.close")
                : t("common.cancel")}
          </Button>
          {stage !== "result" && (
            <Button
              variant="primary"
              onClick={() =>
                stage === "source" ? setStage("preview") : void submit()
              }
              disabled={
                busy ||
                selectedRows.length === 0 ||
                !isCurrentPreview(parseSource, parseText, acceptedKey) ||
                (stage === "preview" && needsProvider)
              }
            >
              {busy
                ? t("agents.tools.import.importing")
                : stage === "source"
                  ? zh
                    ? "解析并预览"
                    : "Preview"
                  : t("agents.tools.import.submit", {
                      count: selectedRows.length,
                    })}
            </Button>
          )}
        </>
      }
    >
      <div className="capability-form space-y-6">
        <ol
          className="import-steps"
          aria-label={zh ? "导入步骤" : "Import steps"}
        >
          {(["source", "preview", "result"] as const).map((step, index) => (
            <li
              key={step}
              aria-current={stage === step ? "step" : undefined}
              className={cn(
                "flex items-center gap-2",
                stage === step ? "font-medium text-ink" : "text-ink-3",
              )}
            >
              <span className="grid h-6 w-6 place-items-center rounded-full border border-line">
                {(["source", "preview", "result"].indexOf(stage) > index) ? <Check size={18} /> : index + 1}
              </span>
              {zh
                ? ["来源", "预览", "完成"][index]
                : ["Source", "Preview", "Done"][index]}
            </li>
          ))}
        </ol>
        {stage === "result" && (
          <div aria-live="polite" className="divide-y divide-line">
            {results.map((result, index) => (
              <div
                key={index}
                className="flex items-center justify-between gap-4 py-4 text-sm"
              >
                <span>{result.name}</span>
                <span
                  className={
                    result.status === "failed" ? "text-danger" : "text-ink-2"
                  }
                >
                  {
                    {
                      created: zh ? "已导入" : "Imported",
                      updated: zh ? "已更新" : "Updated",
                      skipped: zh ? "已跳过" : "Skipped",
                      failed: zh
                        ? "失败，请检查配置"
                        : "Failed; check configuration",
                    }[result.status]
                  }
                </span>
              </div>
            ))}
          </div>
        )}
        <div hidden={stage !== "source"} className="space-y-5">
          <TabBar
            aria-label={t("agents.tools.import.title")}
            value={tab}
            onValueChange={(value) => switchTab(value as ImportTab)}
            items={[
              { value: "mcp", label: t("agents.tools.import.tabMcp") },
              { value: "skills", label: t("agents.tools.import.tabSkills") },
            ]}
          />

          {tab === "mcp" ? (
            <div className="space-y-3">
              <TabBar
                aria-label={t("agents.tools.import.tabMcp")}
                value={mcpSource}
                onValueChange={(value) => switchMcpSource(value as McpSource)}
                items={[
                  {
                    value: "template",
                    label: t("agents.tools.import.sourceTemplate"),
                  },
                  {
                    value: "paste",
                    label: t("agents.tools.import.sourcePaste"),
                  },
                  {
                    value: "command",
                    label: t("agents.tools.import.sourceCommand"),
                  },
                  { value: "scan", label: t("agents.tools.import.sourceScan") },
                ]}
              />

              {mcpSource === "template" && (
                <div className="divide-y divide-line border-y border-line">
                  {MCP_TEMPLATES.map((template) => {
                    const active = picked.includes(template.id);
                    const values = templateValues[template.id] ?? {};
                    return (
                      <div
                        key={template.id}
                        className={cn(
                          "px-1 py-4 transition-colors",
                          active ? "bg-panel/30" : "bg-card",
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
                                : [...prev, template.id],
                            )
                          }
                          className="flex w-full items-start gap-2.5 text-left"
                        >
                          <span
                            className={cn(
                              "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border",
                              active
                                ? "border-accent bg-accent text-on-accent"
                                : "border-line-strong",
                            )}
                          >
                            {active && (
                              <Check className="h-3 w-3" aria-hidden />
                            )}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[13px] font-medium text-ink">
                              {template.name}
                            </span>
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
                                      [template.id]: {
                                        ...(prev[template.id] ?? {}),
                                        [field.argIndex]: event.target.value,
                                      },
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
                          <p className="mt-1.5 text-xs text-warn">
                            {t("agents.tools.import.templateFill")}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {mcpSource === "paste" && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => jsonFileRef.current?.click()}
                    >
                      <FileUp className="h-4 w-4" />
                      {zh ? "选择 JSON 文件" : "Choose JSON file"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setRevealSource((value) => !value)}
                    >
                      {revealSource
                        ? zh
                          ? "隐藏敏感值"
                          : "Hide secrets"
                        : zh
                          ? "编辑 JSON 原文"
                          : "Edit source JSON"}
                    </Button>
                    {jsonFileName && (
                      <span className="text-sm text-ink-3">{jsonFileName}</span>
                    )}
                    <input
                      ref={jsonFileRef}
                      type="file"
                      accept=".json,application/json"
                      hidden
                      onChange={(event) => void onJsonFile(event)}
                    />
                  </div>
                  <Field
                    label={t("agents.tools.import.pasteLabel")}
                    htmlFor="import-paste"
                  >
                    <Textarea
                      id="import-paste"
                      autoFocus
                      rows={10}
                      value={revealSource ? pasteText : maskedJson(pasteText)}
                      readOnly={!revealSource}
                      onChange={(event) => updatePaste(event.target.value)}
                      placeholder={t("agents.tools.import.pastePlaceholder")}
                      spellCheck={false}
                      className="font-mono text-[13px] leading-relaxed"
                    />
                  </Field>
                </div>
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
                    onChange={(event) => {
                      invalidatePreview();
                      setCommandText(event.target.value);
                    }}
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
                      {discovering
                        ? t("agents.tools.import.discovering")
                        : t("agents.tools.import.sourceScan")}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={runDiscover}
                      disabled={discovering}
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden />{" "}
                      {t("agents.tools.import.rescan")}
                    </Button>
                  </div>
                  <div className="divide-y divide-line border-y border-line">
                    {sources.map((source) => (
                      <div
                        key={source.id}
                        className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium text-ink">
                            {source.label}
                          </p>
                          <p
                            className="truncate font-mono text-[11px] text-ink-3"
                            title={source.path}
                          >
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
                onValueChange={(value) =>
                  switchSkillSource(value as SkillSource)
                }
                items={[
                  { value: "file", label: t("agents.tools.import.sourceFile") },
                  { value: "dir", label: t("agents.tools.import.sourceDir") },
                ]}
              />

              {skillSource === "file" ? (
                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <FileUp className="h-3.5 w-3.5" aria-hidden />{" "}
                      {t("agents.tools.import.chooseFile")}
                    </Button>
                    {skillFileName && (
                      <span className="text-xs text-ink-3">
                        {skillFileName}
                      </span>
                    )}
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
                        invalidatePreview();
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
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void pickScanDir()}
                      disabled={scanning}
                    >
                      <FolderOpen className="h-3.5 w-3.5" aria-hidden />{" "}
                      {t("agents.tools.import.chooseDir")}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => runScan(scanDir)}
                      disabled={scanning || !scanDir.trim()}
                    >
                      {scanning
                        ? t("agents.tools.import.scanning")
                        : t("agents.tools.import.rescan")}
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-ink-3">
                      {t("agents.tools.import.presetDirs")}
                    </span>
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
                      {t("agents.tools.import.scanned", {
                        count: scan.scannedFiles,
                      })}
                      {scan.truncated &&
                        ` · ${t("agents.tools.import.truncated")}`}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        {stage !== "result" && errors.length > 0 && (
          <div
            role="alert"
            className="space-y-1 rounded-xl border border-danger/25 bg-danger/10 px-3.5 py-2.5 text-xs leading-relaxed text-danger"
          >
            {errors.map((error) => (
              <p key={error}>{error.replace(/"[^"\n]*"/g, "••••")}</p>
            ))}
          </div>
        )}

        <div hidden={stage !== "preview"} className="space-y-6">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[13px] font-medium text-ink-2">
                {t("agents.tools.import.previewTitle")}
                {rows.length > 0 && (
                  <span className="ml-1.5 text-ink-3">{rows.length}</span>
                )}
              </p>
              {rows.length > 0 && (
                <Button variant="ghost" size="sm" onClick={toggleAll}>
                  {t("agents.tools.import.selectAll")}
                </Button>
              )}
            </div>

            {rows.length === 0 ? (
              <p className="py-6 text-center text-xs text-ink-3">
                {t("agents.tools.import.previewEmpty")}
              </p>
            ) : (
              <ul className="import-preview-list">
                {rows.map((row) => {
                  const checked = !deselected.includes(row.key);
                  return (
                    <li key={row.key} className="import-preview-card">
                      <div className="import-preview-heading">
                        <button type="button" role="checkbox" aria-label={row.name} aria-checked={checked} onClick={() => toggleRow(row.key)} className={cn("import-checkbox", checked && "is-checked")}>{checked && <Check size={16} />}</button>
                        <details className="import-server-details" open={rows[0]?.key === row.key}>
                          <summary><ChevronDown size={21} /><span>{row.name}</span>{row.config && <Tag label={row.config.transport} />}{row.exists && <Tag label={zh ? "同名冲突" : "Name conflict"} className="border-warn/25 bg-warn/10 text-warn" />}</summary>
                          {row.config ? <McpConfigurationTable config={row.config} zh={zh} /> : <p className="model-help">{row.detail}</p>}
                          {row.warnings.map((warning) => <p key={warning} className="flex items-center gap-2 px-4 pb-3 text-sm text-warn"><AlertTriangle size={16} />{warning.replace(/"[^"\n]*"/g, "••••")}</p>)}
                        </details>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="import-destination">
          <Field
            label={t("agents.tools.import.providersLabel")}
            hint={
              needsProvider ? undefined : t("agents.tools.import.providersHint")
            }
            error={
              needsProvider ? t("agents.tools.import.needProvider") : undefined
            }
          >
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label={t("agents.tools.import.providersLabel")}
            >
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
                      active
                        ? "border-accent/40 bg-accent-soft text-accent"
                        : "border-line bg-card text-ink-3 hover:text-ink",
                    )}
                  >
                    {active && <Check className="h-3 w-3" aria-hidden />}
                    {provider.name}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field
            label={t("agents.tools.import.conflictLabel")}
            className="import-conflicts"
          >
            <div className="import-conflict-options" role="group" aria-label={t("agents.tools.import.conflictLabel")}>
              {(["skip", "overwrite", "rename"] as const).map((value) => <button key={value} type="button" aria-pressed={conflict === value} onClick={() => setConflict(value)}>{t(`agents.tools.import.conflict${value === "skip" ? "Skip" : value === "overwrite" ? "Overwrite" : "Rename"}`)}</button>)}
            </div>
          </Field>
          </div>
          <p className="import-safety-note flex items-center gap-2 text-ink-3"><ShieldCheck size={20} />
            {zh
              ? "仅导入配置，MCP 保持停用，不会自动启动服务器。"
              : "MCP configurations import disabled. No server is started."}
          </p>
        </div>
      </div>
    </Dialog>
  );
}

function McpConfigurationTable({ config, zh }: { config: NonNullable<PreviewRow["config"]>; zh: boolean }): JSX.Element {
  const safe = redactConfig(config) as NonNullable<PreviewRow["config"]>;
  const entries = Object.entries(safe.env ?? {});
  return <dl className="import-config-table">
    {safe.transport === "http" ? <div><dt>URL</dt><dd>{safe.url}</dd></div> : <><div><dt>{zh ? "命令" : "Command"}</dt><dd>{safe.command}</dd></div><div><dt>{zh ? "参数" : "Arguments"}</dt><dd>{safe.args?.join(" ") || "—"}</dd></div></>}
    {entries.length > 0 && <div><dt>{zh ? "环境变量" : "Environment"}</dt><dd>{entries.map(([key, value]) => <div className="import-env-row" key={key}><span>{key}</span><span>{value}</span></div>)}</dd></div>}
    {safe.headers && <div><dt>{zh ? "请求头" : "Headers"}</dt><dd>{Object.entries(safe.headers).map(([key, value]) => <div className="import-env-row" key={key}><span>{key}</span><span>{value}</span></div>)}</dd></div>}
  </dl>;
}
