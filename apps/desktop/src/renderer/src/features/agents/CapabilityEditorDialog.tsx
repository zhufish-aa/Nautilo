import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Check, FileUp, Plus, Trash2, Wand2 } from "lucide-react";
import type { CapabilityKind, McpServerConfig, McpTransport, ProviderCapability } from "@agenthub/domain";
import { useI18n } from "../../lib/i18n";
import { toDaemonProviderId, toUiProviderId } from "../../lib/core-mappers";
import { useProviderMetas } from "../../lib/provider-catalog";
import { cn } from "../../lib/utils";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Textarea } from "../../components/ui/Input";
import { Switch } from "../../components/ui/Switch";
import { TagInput } from "../../components/ui/TagInput";
import { useProviderToolsStore } from "../../stores/provider-tools";
import { toast } from "../../stores/toast";

interface KeyValueRow {
  key: string;
  value: string;
}

interface FormState {
  kind: CapabilityKind;
  name: string;
  description: string;
  tags: string[];
  /** UI provider ids (custom-cli); converted on save. */
  providerIds: string[];
  enabled: boolean;
  transport: McpTransport;
  command: string;
  args: string[];
  env: KeyValueRow[];
  envPassthrough: string[];
  cwd: string;
  url: string;
  headers: KeyValueRow[];
  bearerTokenEnvVar: string;
  envHeaders: KeyValueRow[];
  instructions: string;
  source: string;
}

interface FormErrors {
  name?: string;
  command?: string;
  url?: string;
  instructions?: string;
  form?: string;
}

function emptyForm(): FormState {
  return {
    kind: "skill",
    name: "",
    description: "",
    tags: [],
    providerIds: [],
    enabled: true,
    transport: "stdio",
    command: "",
    args: [],
    env: [],
    envPassthrough: [],
    cwd: "",
    url: "",
    headers: [],
    bearerTokenEnvVar: "",
    envHeaders: [],
    instructions: "",
    source: ""
  };
}

type McpFormFields = Pick<
  FormState,
  "transport" | "command" | "args" | "env" | "envPassthrough" | "cwd" | "url" | "headers" | "bearerTokenEnvVar" | "envHeaders"
>;

function mcpFields(mcp: McpServerConfig | undefined): McpFormFields {
  return {
    transport: mcp?.transport ?? "stdio",
    command: mcp?.command ?? "",
    args: mcp?.args ?? [],
    env: Object.entries(mcp?.env ?? {}).map(([key, value]) => ({ key, value })),
    envPassthrough: mcp?.envPassthrough ?? [],
    cwd: mcp?.cwd ?? "",
    url: mcp?.url ?? "",
    headers: Object.entries(mcp?.headers ?? {}).map(([key, value]) => ({ key, value })),
    bearerTokenEnvVar: mcp?.bearerTokenEnvVar ?? "",
    envHeaders: Object.entries(mcp?.envHeaders ?? {}).map(([key, value]) => ({ key, value }))
  };
}

function formFromCapability(capability: ProviderCapability): FormState {
  return {
    kind: capability.kind,
    name: capability.name,
    description: capability.description,
    tags: capability.tags,
    providerIds: capability.providerIds.map(toUiProviderId),
    enabled: capability.enabled,
    ...mcpFields(capability.mcp),
    instructions: capability.skill?.instructions ?? "",
    source: capability.skill?.source ?? ""
  };
}

function rowsToRecord(rows: KeyValueRow[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) record[key] = row.value;
  }
  return record;
}

function compact(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Dynamic single-value row list (args, env passthrough). */
function StringRows({
  values,
  onChange,
  placeholder,
  addLabel,
  removeLabel
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  addLabel: string;
  removeLabel: string;
}): JSX.Element {
  return (
    <div className="space-y-2">
      {values.map((value, index) => (
        // Rows have no stable identity; index keys keep editing simple.
        // eslint-disable-next-line react/no-array-index-key
        <div key={index} className="flex items-center gap-2">
          <Input
            value={value}
            onChange={(event) => onChange(values.map((item, i) => (i === index ? event.target.value : item)))}
            placeholder={placeholder}
            className="font-mono text-[13px]"
          />
          <Button variant="ghost" size="icon" onClick={() => onChange(values.filter((_, i) => i !== index))} aria-label={removeLabel}>
            <Trash2 className="h-4 w-4 text-ink-3" aria-hidden />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...values, ""])}>
        <Plus className="h-3.5 w-3.5" aria-hidden /> {addLabel}
      </Button>
    </div>
  );
}

/** Dynamic key+value row list (env vars, HTTP headers). */
function KeyValueRows({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  removeLabel
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel: string;
  removeLabel: string;
}): JSX.Element {
  const patchRow = (index: number, changes: Partial<KeyValueRow>): void =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...changes } : row)));
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={index} className="flex items-center gap-2">
          <Input
            value={row.key}
            onChange={(event) => patchRow(index, { key: event.target.value })}
            placeholder={keyPlaceholder}
            className="font-mono text-[13px]"
          />
          <Input
            value={row.value}
            onChange={(event) => patchRow(index, { value: event.target.value })}
            placeholder={valuePlaceholder}
            className="font-mono text-[13px]"
          />
          <Button variant="ghost" size="icon" onClick={() => onChange(rows.filter((_, i) => i !== index))} aria-label={removeLabel}>
            <Trash2 className="h-4 w-4 text-ink-3" aria-hidden />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...rows, { key: "", value: "" }])}>
        <Plus className="h-3.5 w-3.5" aria-hidden /> {addLabel}
      </Button>
    </div>
  );
}

/** Segmented button group used for kind and MCP transport. */
function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  ariaLabel: string;
}): JSX.Element {
  return (
    <div className="inline-flex rounded-xl border border-line bg-card p-1" role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
            value === option.value ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Shared add/edit dialog for a skill or MCP server capability. */
export function CapabilityEditorDialog({
  open,
  onOpenChange,
  capability
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  capability?: ProviderCapability;
}): JSX.Element {
  const { t } = useI18n();
  const providers = useProviderMetas();
  const saveCapability = useProviderToolsStore((state) => state.save);
  const parseImport = useProviderToolsStore((state) => state.parseImport);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [importedFileName, setImportedFileName] = useState<string | undefined>(undefined);
  const [quickText, setQuickText] = useState("");
  const [quickNote, setQuickNote] = useState<string | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setForm(capability ? formFromCapability(capability) : emptyForm());
      setErrors({});
      setSaving(false);
      setImportedFileName(undefined);
      setQuickText("");
      setQuickNote(undefined);
    }
  }, [open, capability]);

  const patch = (changes: Partial<FormState>): void => setForm((prev) => ({ ...prev, ...changes }));

  /** Fills the MCP half of the form from a pasted config block or launch command. */
  const applyQuickFill = async (): Promise<void> => {
    const text = quickText.trim();
    if (!text) return;
    setQuickNote(undefined);
    try {
      // A config block starts with a brace; anything else is a shell command.
      const preview = await parseImport({ source: text.startsWith("{") ? "mcpJson" : "mcpCommand", text });
      if (preview.mcpServers.length === 0) {
        setQuickNote(preview.errors[0] ?? t("agents.tools.editor.quickFillNone"));
        return;
      }
      if (preview.mcpServers.length > 1) {
        setQuickNote(t("agents.tools.editor.quickFillMulti", { count: preview.mcpServers.length }));
        return;
      }
      const candidate = preview.mcpServers[0];
      setForm((prev) => ({
        ...prev,
        ...mcpFields(candidate.mcp),
        enabled: candidate.enabled,
        name: prev.name.trim() ? prev.name : candidate.name,
        description: prev.description.trim() ? prev.description : candidate.description,
        tags: prev.tags.length > 0 ? prev.tags : candidate.tags
      }));
      setQuickText("");
      if (candidate.warnings.length > 0) toast.info(candidate.warnings.join(" · "));
    } catch (error) {
      setQuickNote(messageOf(error));
    }
  };

  const importSkillFile = async (file: File): Promise<void> => {
    try {
      const preview = await parseImport({ source: "skillMarkdown", text: await file.text(), fileName: file.name });
      if (preview.skills.length === 0) {
        toast.error(preview.errors[0] ?? t("agents.tools.editor.quickFillNone"));
        return;
      }
      if (preview.skills.length > 1) {
        toast.info(t("agents.tools.editor.quickFillMulti", { count: preview.skills.length }));
        return;
      }
      const skill = preview.skills[0];
      setForm((prev) => ({
        ...prev,
        instructions: skill.instructions,
        enabled: skill.enabled,
        name: prev.name.trim() ? prev.name : skill.name,
        description: prev.description.trim() ? prev.description : skill.description,
        tags: prev.tags.length > 0 ? prev.tags : skill.tags,
        source: prev.source.trim() ? prev.source : (skill.source ?? ""),
        providerIds: prev.providerIds.length > 0 ? prev.providerIds : skill.providerIds.map(toUiProviderId)
      }));
      setImportedFileName(file.name);
      if (skill.warnings.length > 0) toast.info(skill.warnings.join(" · "));
    } catch (error) {
      toast.error(messageOf(error));
    }
  };

  const onFileChosen = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Allow re-importing the same file.
    event.target.value = "";
    if (file) void importSkillFile(file);
  };

  const toggleProvider = (providerId: string): void =>
    patch({
      providerIds: form.providerIds.includes(providerId)
        ? form.providerIds.filter((id) => id !== providerId)
        : [...form.providerIds, providerId]
    });

  const save = async (): Promise<void> => {
    const nextErrors: FormErrors = {};
    if (!form.name.trim()) nextErrors.name = t("agents.tools.editor.nameRequired");
    if (form.kind === "mcp" && form.transport === "stdio" && !form.command.trim()) {
      nextErrors.command = t("agents.tools.editor.commandRequired");
    }
    if (form.kind === "mcp" && form.transport === "http" && !form.url.trim()) {
      nextErrors.url = t("agents.tools.editor.urlRequired");
    }
    if (form.kind === "skill" && !form.instructions.trim()) {
      nextErrors.instructions = t("agents.tools.editor.instructionsRequired");
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const now = new Date().toISOString();
    const args = compact(form.args);
    const env = rowsToRecord(form.env);
    const envPassthrough = compact(form.envPassthrough);
    const headers = rowsToRecord(form.headers);
    const envHeaders = rowsToRecord(form.envHeaders);
    const next: ProviderCapability = {
      id: capability?.id ?? crypto.randomUUID(),
      kind: form.kind,
      name: form.name.trim(),
      description: form.description.trim(),
      tags: form.tags,
      enabled: form.enabled,
      providerIds: form.providerIds.map(toDaemonProviderId),
      createdAt: capability?.createdAt ?? now,
      updatedAt: now,
      ...(form.kind === "mcp"
        ? {
            mcp:
              form.transport === "stdio"
                ? {
                    transport: "stdio" as const,
                    command: form.command.trim(),
                    ...(args.length > 0 ? { args } : {}),
                    ...(Object.keys(env).length > 0 ? { env } : {}),
                    ...(envPassthrough.length > 0 ? { envPassthrough } : {}),
                    ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {})
                  }
                : {
                    transport: "http" as const,
                    url: form.url.trim(),
                    ...(form.bearerTokenEnvVar.trim() ? { bearerTokenEnvVar: form.bearerTokenEnvVar.trim() } : {}),
                    ...(Object.keys(headers).length > 0 ? { headers } : {}),
                    ...(Object.keys(envHeaders).length > 0 ? { envHeaders } : {})
                  }
          }
        : {
            skill: {
              instructions: form.instructions.trim(),
              ...(form.source.trim() ? { source: form.source.trim() } : {}),
              // The form has no field for this; keep the scanned origin so the
              // resource mirror keeps working after an edit.
              ...(capability?.skill?.resourceDir ? { resourceDir: capability.skill.resourceDir } : {})
            }
          })
    };

    setSaving(true);
    try {
      await saveCapability(next);
      toast.success(t("agents.tools.savedToast", { name: next.name }));
      onOpenChange(false);
    } catch (error) {
      setErrors({ form: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={capability ? t("agents.tools.editor.editTitle") : t("agents.tools.editor.createTitle")}
      description={capability ? undefined : t("agents.tools.editor.createDesc")}
      widthClass="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t("agents.tools.editor.kindLabel")}>
          <Segmented<CapabilityKind>
            ariaLabel={t("agents.tools.editor.kindLabel")}
            value={form.kind}
            onChange={(kind) => patch({ kind })}
            options={[
              { value: "skill", label: t("agents.tools.typeSkill") },
              { value: "mcp", label: t("agents.tools.typeMcp") }
            ]}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("agents.tools.editor.name")} htmlFor="capability-name" error={errors.name}>
            <Input
              id="capability-name"
              autoFocus
              value={form.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder={t("agents.tools.editor.namePlaceholder")}
            />
          </Field>
          <Field label={t("agents.tools.editor.tags")}>
            <TagInput
              aria-label={t("agents.tools.editor.tags")}
              values={form.tags}
              onChange={(tags) => patch({ tags })}
              placeholder={t("agents.tools.editor.tagsPlaceholder")}
            />
          </Field>
        </div>

        <Field label={t("agents.tools.editor.description")} htmlFor="capability-description">
          <Textarea
            id="capability-description"
            value={form.description}
            onChange={(event) => patch({ description: event.target.value })}
            placeholder={t("agents.tools.editor.descriptionPlaceholder")}
          />
        </Field>

        <Field label={t("agents.tools.editor.providers")} hint={t("agents.tools.editor.providersHint")}>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("agents.tools.editor.providers")}>
            {providers.map((provider) => {
              const active = form.providerIds.includes(provider.id);
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

        {form.kind === "mcp" ? (
          <div className="space-y-4 rounded-xl border border-line bg-card-hover/50 p-3.5">
            <Field
              label={t("agents.tools.editor.quickFill")}
              htmlFor="capability-quick-fill"
              hint={quickNote ? undefined : t("agents.tools.editor.quickFillHint")}
              error={quickNote}
            >
              <Textarea
                id="capability-quick-fill"
                rows={3}
                value={quickText}
                onChange={(event) => setQuickText(event.target.value)}
                placeholder={t("agents.tools.editor.quickFillPlaceholder")}
                spellCheck={false}
                className="font-mono text-[13px]"
              />
              <Button variant="outline" size="sm" onClick={() => void applyQuickFill()} disabled={!quickText.trim()}>
                <Wand2 className="h-3.5 w-3.5" aria-hidden /> {t("agents.tools.editor.quickFillApply")}
              </Button>
            </Field>

            <Field label={t("agents.tools.editor.transport")}>
              <Segmented<McpTransport>
                ariaLabel={t("agents.tools.editor.transport")}
                value={form.transport}
                onChange={(transport) => patch({ transport })}
                options={[
                  { value: "stdio", label: t("agents.tools.editor.transportStdio") },
                  { value: "http", label: t("agents.tools.editor.transportHttp") }
                ]}
              />
            </Field>

            {form.transport === "stdio" ? (
              <>
                <Field label={t("agents.tools.editor.command")} htmlFor="capability-command" error={errors.command}>
                  <Input
                    id="capability-command"
                    value={form.command}
                    onChange={(event) => patch({ command: event.target.value })}
                    placeholder={t("agents.tools.editor.commandPlaceholder")}
                    spellCheck={false}
                    className="font-mono text-[13px]"
                  />
                </Field>
                <Field label={t("agents.tools.editor.args")}>
                  <StringRows
                    values={form.args}
                    onChange={(args) => patch({ args })}
                    placeholder={t("agents.tools.editor.argPlaceholder")}
                    addLabel={t("agents.tools.editor.addRow")}
                    removeLabel={t("agents.tools.editor.removeRow")}
                  />
                </Field>
                <Field label={t("agents.tools.editor.env")}>
                  <KeyValueRows
                    rows={form.env}
                    onChange={(env) => patch({ env })}
                    keyPlaceholder={t("agents.tools.editor.envKeyPlaceholder")}
                    valuePlaceholder={t("agents.tools.editor.envValuePlaceholder")}
                    addLabel={t("agents.tools.editor.addRow")}
                    removeLabel={t("agents.tools.editor.removeRow")}
                  />
                </Field>
                <Field label={t("agents.tools.editor.envPassthrough")} hint={t("agents.tools.editor.envPassthroughHint")}>
                  <StringRows
                    values={form.envPassthrough}
                    onChange={(envPassthrough) => patch({ envPassthrough })}
                    placeholder={t("agents.tools.editor.passthroughPlaceholder")}
                    addLabel={t("agents.tools.editor.addRow")}
                    removeLabel={t("agents.tools.editor.removeRow")}
                  />
                </Field>
                <Field label={t("agents.tools.editor.cwd")} htmlFor="capability-cwd">
                  <Input
                    id="capability-cwd"
                    value={form.cwd}
                    onChange={(event) => patch({ cwd: event.target.value })}
                    placeholder={t("agents.tools.editor.cwdPlaceholder")}
                    spellCheck={false}
                    className="font-mono text-[13px]"
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label={t("agents.tools.editor.url")} htmlFor="capability-url" error={errors.url}>
                  <Input
                    id="capability-url"
                    value={form.url}
                    onChange={(event) => patch({ url: event.target.value })}
                    placeholder={t("agents.tools.editor.urlPlaceholder")}
                    spellCheck={false}
                    className="font-mono text-[13px]"
                  />
                </Field>
                <Field label={t("agents.tools.editor.bearerToken")} htmlFor="capability-bearer" hint={t("agents.tools.editor.bearerTokenHint")}>
                  <Input
                    id="capability-bearer"
                    value={form.bearerTokenEnvVar}
                    onChange={(event) => patch({ bearerTokenEnvVar: event.target.value })}
                    placeholder={t("agents.tools.editor.bearerTokenPlaceholder")}
                    spellCheck={false}
                    className="font-mono text-[13px]"
                  />
                </Field>
                <Field label={t("agents.tools.editor.headers")}>
                  <KeyValueRows
                    rows={form.headers}
                    onChange={(headers) => patch({ headers })}
                    keyPlaceholder={t("agents.tools.editor.headerKeyPlaceholder")}
                    valuePlaceholder={t("agents.tools.editor.headerValuePlaceholder")}
                    addLabel={t("agents.tools.editor.addRow")}
                    removeLabel={t("agents.tools.editor.removeRow")}
                  />
                </Field>
                <Field label={t("agents.tools.editor.envHeaders")} hint={t("agents.tools.editor.envHeadersHint")}>
                  <KeyValueRows
                    rows={form.envHeaders}
                    onChange={(envHeaders) => patch({ envHeaders })}
                    keyPlaceholder={t("agents.tools.editor.headerKeyPlaceholder")}
                    valuePlaceholder={t("agents.tools.editor.envVarNamePlaceholder")}
                    addLabel={t("agents.tools.editor.addRow")}
                    removeLabel={t("agents.tools.editor.removeRow")}
                  />
                </Field>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4 rounded-xl border border-line bg-card-hover/50 p-3.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <FileUp className="h-3.5 w-3.5" aria-hidden /> {t("agents.tools.editor.importFile")}
              </Button>
              {importedFileName && (
                <span className="text-xs text-ink-3">{t("agents.tools.editor.importedFile", { name: importedFileName })}</span>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown"
                className="hidden"
                tabIndex={-1}
                aria-hidden
                onChange={onFileChosen}
              />
            </div>
            <Field label={t("agents.tools.editor.instructions")} htmlFor="capability-instructions" error={errors.instructions}>
              <Textarea
                id="capability-instructions"
                rows={12}
                value={form.instructions}
                onChange={(event) => patch({ instructions: event.target.value })}
                placeholder={t("agents.tools.editor.instructionsPlaceholder")}
                spellCheck={false}
                className="font-mono text-[13px] leading-relaxed"
              />
            </Field>
            <Field label={t("agents.tools.editor.source")} htmlFor="capability-source">
              <Input
                id="capability-source"
                value={form.source}
                onChange={(event) => patch({ source: event.target.value })}
                placeholder={t("agents.tools.editor.sourcePlaceholder")}
              />
            </Field>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card-hover px-3.5 py-3">
          <div>
            <p className="text-[13px] font-medium text-ink-2">{t("agents.tools.editor.enabled")}</p>
            <p className="text-xs text-ink-3">{t("agents.tools.editor.enabledHint")}</p>
          </div>
          <Switch
            checked={form.enabled}
            onCheckedChange={(enabled) => patch({ enabled })}
            aria-label={t("agents.tools.editor.enabled")}
          />
        </div>

        {errors.form && (
          <p role="alert" className="rounded-xl border border-danger/25 bg-danger/10 px-3.5 py-2.5 text-xs leading-relaxed text-danger">
            {errors.form}
          </p>
        )}
      </div>
    </Dialog>
  );
}
