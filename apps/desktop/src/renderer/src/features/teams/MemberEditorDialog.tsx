import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { PermissionPolicy } from "@agenthub/domain";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { requestCore } from "../../lib/bridge";
import { cn, newId } from "../../lib/utils";
import { STRENGTH_AREA_KEYS, TASK_TYPE_KEYS } from "../../lib/types";
import type { UiTeamMember } from "../../lib/types";
import { Button } from "../../components/ui/Button";
import { ComboboxInput } from "../../components/ui/ComboboxInput";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Textarea } from "../../components/ui/Input";
import { ScoreDots } from "../../components/ui/ScoreDots";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { TabBar } from "../../components/ui/Tabs";
import { TagInput } from "../../components/ui/TagInput";
import { useAgentsStore } from "../../stores/agents";
import { toast } from "../../stores/toast";

interface StrengthRow {
  id: string;
  area: string;
  score: number;
}

interface MemberForm {
  displayName: string;
  agentInstanceId: string;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
  maxConcurrentTasks: number;
  allowedTaskTypes: string[];
  enabled: boolean;
  roleName: string;
  roleDescription: string;
  responsibilities: string[];
  limitations: string[];
  systemInstructions: string;
  permissionPolicyId: string;
}

function formFromMember(member?: UiTeamMember): { form: MemberForm; strengths: StrengthRow[] } {
  if (!member) {
    return {
      form: {
        displayName: "",
        agentInstanceId: "",
        model: "",
        reasoningEffort: "",
        serviceTier: "",
        maxConcurrentTasks: 1,
        allowedTaskTypes: ["code"],
        enabled: true,
        roleName: "",
        roleDescription: "",
        responsibilities: [],
        limitations: [],
        systemInstructions: "",
        permissionPolicyId: "default"
      },
      strengths: []
    };
  }
  return {
    form: {
      displayName: member.displayName,
      agentInstanceId: member.agentInstanceId,
      model: member.model ?? "",
      reasoningEffort: member.reasoningEffort ?? "",
      serviceTier: member.serviceTier ?? "",
      maxConcurrentTasks: member.maxConcurrentTasks,
      allowedTaskTypes: [...member.allowedTaskTypes],
      enabled: member.enabled,
      roleName: member.role.name,
      roleDescription: member.role.description,
      responsibilities: [...member.role.responsibilities],
      limitations: [...member.role.limitations],
      systemInstructions: member.role.systemInstructions,
      permissionPolicyId: member.role.permissionPolicyId ?? "default"
    },
    strengths: Object.entries(member.role.strengths).map(([area, score]) => ({
      id: newId("str"),
      area,
      score
    }))
  };
}

export function MemberEditorDialog({
  open,
  onOpenChange,
  member,
  onSave
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member?: UiTeamMember;
  onSave: (draft: Omit<UiTeamMember, "id">) => void;
}): JSX.Element {
  const { t } = useI18n();
  const instances = useAgentsStore((state) => state.instances);
  const modelCatalogs = useAgentsStore((state) => state.modelCatalogs);
  const loadingModels = useAgentsStore((state) => state.loadingModels);
  const loadModels = useAgentsStore((state) => state.loadModels);

  const [tab, setTab] = useState("basic");
  const [form, setForm] = useState<MemberForm>(() => formFromMember(undefined).form);
  const [strengthRows, setStrengthRows] = useState<StrengthRow[]>([]);
  const [customTaskDraft, setCustomTaskDraft] = useState("");
  const [errors, setErrors] = useState<{ name?: string; instance?: string }>({});
  const [policies, setPolicies] = useState<PermissionPolicy[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    requestCore<PermissionPolicy[]>("policy.list")
      .then((list) => { if (!cancelled) setPolicies(list); })
      .catch(() => { if (!cancelled) setPolicies([]); });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (open) {
      const initial = formFromMember(member);
      setForm(initial.form);
      setStrengthRows(initial.strengths);
      setCustomTaskDraft("");
      setTab("basic");
      setErrors({});
    }
  }, [open, member]);

  const patch = (changes: Partial<MemberForm>): void => setForm((prev) => ({ ...prev, ...changes }));
  const selectedInstance = instances.find((instance) => instance.id === form.agentInstanceId);
  const modelCatalog = selectedInstance ? modelCatalogs[selectedInstance.id] : undefined;
  const selectedModel = modelCatalog?.models.find((model) => model.id === form.model);
  const modelOptions = useMemo(() => (modelCatalog?.models ?? []).map((model) => ({
    value: model.id,
    label: model.displayName,
    description: model.description,
    badge: model.isDefault ? t("agents.editor.basic.modelDefault") : undefined
  })), [modelCatalog, t]);
  const reasoningOptions = (selectedModel?.reasoningEfforts ?? []).map((effort) => ({ value: effort, label: effort }));

  useEffect(() => {
    if (!open || !selectedInstance || modelCatalog) return;
    void loadModels(selectedInstance.id);
  }, [loadModels, modelCatalog, open, selectedInstance]);

  const presetTaskTypes = TASK_TYPE_KEYS as readonly string[];
  const customTaskTypes = form.allowedTaskTypes.filter((type) => !presetTaskTypes.includes(type));

  const toggleTaskType = (taskType: string): void => {
    patch({
      allowedTaskTypes: form.allowedTaskTypes.includes(taskType)
        ? form.allowedTaskTypes.filter((item) => item !== taskType)
        : [...form.allowedTaskTypes, taskType]
    });
  };

  const commitCustomTaskType = (): void => {
    const value = customTaskDraft.trim();
    if (value && !form.allowedTaskTypes.includes(value)) {
      patch({ allowedTaskTypes: [...form.allowedTaskTypes, value] });
    }
    setCustomTaskDraft("");
  };

  const onCustomTaskKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitCustomTaskType();
    }
  };

  const save = (): void => {
    const nextErrors: typeof errors = {};
    if (!form.displayName.trim()) nextErrors.name = t("agents.editor.nameRequired");
    if (!form.agentInstanceId) nextErrors.instance = t("agents.editor.providerRequired");
    setErrors(nextErrors);
    if (nextErrors.name || nextErrors.instance) {
      setTab("basic");
      return;
    }

    const strengths: Record<string, number> = {};
    for (const row of strengthRows) {
      const area = row.area.trim();
      if (area) strengths[area] = row.score;
    }

    onSave({
      displayName: form.displayName.trim(),
      agentInstanceId: form.agentInstanceId,
      model: form.model.trim() || undefined,
      reasoningEffort: form.reasoningEffort.trim() || undefined,
      serviceTier: form.serviceTier || undefined,
      maxConcurrentTasks: form.maxConcurrentTasks,
      allowedTaskTypes: form.allowedTaskTypes,
      enabled: form.enabled,
      role: {
        id: member?.role.id ?? newId("role"),
        name: form.roleName.trim() || form.displayName.trim(),
        description: form.roleDescription.trim(),
        responsibilities: form.responsibilities,
        strengths,
        limitations: form.limitations,
        systemInstructions: form.systemInstructions.trim(),
        permissionPolicyId: form.permissionPolicyId
      }
    });
    toast.success(t(member ? "agents.editor.savedToast" : "agents.editor.createdToast", { name: form.displayName.trim() }));
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={member ? t("teams.member.editTitle") : t("teams.member.createTitle")}
      widthClass="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={save}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <TabBar
          aria-label={member ? t("teams.member.editTitle") : t("teams.member.createTitle")}
          value={tab}
          onValueChange={setTab}
          items={[
            { value: "basic", label: t("teams.member.tabs.basic") },
            { value: "role", label: t("teams.member.tabs.role") }
          ]}
        />

        {tab === "basic" && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t("teams.member.nameLabel")} htmlFor="member-name" error={errors.name}>
              <Input
                id="member-name"
                value={form.displayName}
                onChange={(event) => patch({ displayName: event.target.value })}
                placeholder={t("teams.member.namePlaceholder")}
                autoFocus
              />
            </Field>

            <Field label={t("teams.member.instanceLabel")} error={errors.instance}>
              <SelectField
                aria-label={t("teams.member.instanceLabel")}
                value={form.agentInstanceId || undefined}
                onValueChange={(value) => patch({
                  agentInstanceId: value,
                  model: "",
                  reasoningEffort: "",
                  serviceTier: ""
                })}
                options={instances.map((instance) => ({
                  value: instance.id,
                  label: instance.displayName,
                  hint: instance.providerId
                }))}
                placeholder={t("teams.member.instancePlaceholder")}
              />
            </Field>

            <Field
              label={t("agents.editor.basic.model")}
              hint={form.model.trim() && !selectedModel
                ? t("agents.editor.basic.modelCustom")
                : modelCatalog?.warning
                ?? (modelCatalog?.source === "provider_api"
                  ? t("agents.editor.basic.modelLoadedApi", { count: modelCatalog.models.length })
                  : modelCatalog?.source === "provider_cli"
                  ? t("agents.editor.basic.modelLoaded", {
                    count: modelCatalog.models.length,
                    default: modelCatalog.defaultModel ?? t("agents.editor.basic.reasoningDefault")
                  })
                  : t("agents.editor.basic.modelHint"))}
            >
              <div className="flex gap-2">
                <ComboboxInput
                  id="member-model"
                  value={form.model}
                  onChange={(model) => {
                    const next = modelCatalog?.models.find((item) => item.id === model);
                    patch({
                      model,
                      reasoningEffort: next?.defaultReasoningEffort ?? "",
                      serviceTier: next?.defaultServiceTier ?? ""
                    });
                  }}
                  options={modelOptions}
                  loading={!!selectedInstance && loadingModels[selectedInstance.id]}
                  customOptionLabel={t("agents.editor.basic.modelUseCustom")}
                  customOptionDescription={t("agents.editor.basic.modelCustom")}
                  placeholder={modelCatalog?.defaultModel
                    ? t("agents.editor.basic.modelDefaultPlaceholder", { model: modelCatalog.defaultModel })
                    : t("agents.editor.basic.modelPlaceholder")}
                  className="font-mono text-[13px]"
                />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t("agents.editor.basic.refreshModels")}
                  disabled={!selectedInstance || loadingModels[selectedInstance.id]}
                  onClick={() => selectedInstance && void loadModels(selectedInstance.id)}
                >
                  <RefreshCw className={`h-4 w-4 ${selectedInstance && loadingModels[selectedInstance.id] ? "animate-spin" : ""}`} aria-hidden />
                </Button>
              </div>
            </Field>

            <Field
              label={t("agents.editor.basic.reasoning")}
              hint={selectedModel
                ? t("agents.editor.basic.reasoningHint", { model: selectedModel.displayName })
                : t("agents.editor.basic.reasoningUnavailable")}
            >
              <ComboboxInput
                id="member-reasoning"
                value={form.reasoningEffort}
                onChange={(reasoningEffort) => patch({ reasoningEffort })}
                options={reasoningOptions}
                placeholder={t("agents.editor.basic.reasoningDefault")}
                customOptionLabel={t("agents.editor.basic.reasoningUseCustom")}
                className="font-mono text-[13px]"
              />
            </Field>

            <Field label={t("teams.member.maxConcurrent")} htmlFor="member-concurrent">
              <Input
                id="member-concurrent"
                type="number"
                min={1}
                max={8}
                value={form.maxConcurrentTasks}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  if (!Number.isNaN(parsed)) patch({ maxConcurrentTasks: Math.min(8, Math.max(1, parsed)) });
                }}
              />
            </Field>

            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card-hover px-3.5 py-3">
              <div>
                <p className="text-[13px] font-medium text-ink-2">{t("teams.member.enabled")}</p>
                <p className="text-xs text-ink-3">{t("teams.member.enabledHint")}</p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(enabled) => patch({ enabled })}
                aria-label={t("teams.member.enabled")}
              />
            </div>

            <div className="sm:col-span-2">
              <p className="mb-2 text-[13px] font-medium text-ink-2">{t("teams.member.taskTypes")}</p>
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("teams.member.taskTypes")}>
                {TASK_TYPE_KEYS.map((taskType) => {
                  const active = form.allowedTaskTypes.includes(taskType);
                  return (
                    <button
                      key={taskType}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleTaskType(taskType)}
                      className={cn(
                        "h-8 rounded-lg border px-3 text-[13px] font-medium transition-all duration-150 outline-none",
                        "focus-visible:ring-2 focus-visible:ring-accent/70",
                        active
                          ? "border-accent/50 bg-accent-soft text-accent"
                          : "border-line bg-card text-ink-3 hover:border-line-strong hover:text-ink-2"
                      )}
                    >
                      {t(`taskTypes.${taskType}` as MessageKey)}
                    </button>
                  );
                })}
                {customTaskTypes.map((taskType) => (
                  <span
                    key={taskType}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-accent/50 bg-accent-soft pl-3 pr-1.5 text-[13px] font-medium text-accent"
                  >
                    {taskType}
                    <button
                      type="button"
                      aria-label={`${t("common.remove")} ${taskType}`}
                      onClick={() => toggleTaskType(taskType)}
                      className="rounded p-0.5 text-accent/70 transition-colors hover:text-accent focus-visible:ring-1 focus-visible:ring-accent/70 focus-visible:outline-none"
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </span>
                ))}
                <input
                  value={customTaskDraft}
                  onChange={(event) => setCustomTaskDraft(event.target.value)}
                  onKeyDown={onCustomTaskKeyDown}
                  onBlur={commitCustomTaskType}
                  placeholder={t("teams.member.customTaskTypePlaceholder")}
                  aria-label={t("teams.member.customTaskTypePlaceholder")}
                  className="h-8 w-44 rounded-lg border border-dashed border-line-strong bg-transparent px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-3/70 hover:border-accent/40 focus:border-accent/60 focus:ring-2 focus:ring-accent/25"
                />
              </div>
            </div>
          </div>
        )}

        {tab === "role" && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t("teams.role.name")} htmlFor="role-name">
                <Input
                  id="role-name"
                  value={form.roleName}
                  onChange={(event) => patch({ roleName: event.target.value })}
                  placeholder={t("teams.role.namePlaceholder")}
                />
              </Field>
              <Field label={t("teams.role.description")} htmlFor="role-desc">
                <Input
                  id="role-desc"
                  value={form.roleDescription}
                  onChange={(event) => patch({ roleDescription: event.target.value })}
                  placeholder={t("teams.role.descriptionPlaceholder")}
                />
              </Field>
            </div>

            <Field label={t("teams.role.permissionPolicy")} hint={t("teams.role.permissionPolicyHint")}>
              <SelectField
                aria-label={t("teams.role.permissionPolicy")}
                value={form.permissionPolicyId}
                onValueChange={(permissionPolicyId) => patch({ permissionPolicyId })}
                options={(policies.length ? policies : [{ id: form.permissionPolicyId, name: form.permissionPolicyId }]).map((policy) => ({
                  value: policy.id,
                  label: policy.name || policy.id,
                  hint: policy.id
                }))}
              />
            </Field>

            <Field label={t("teams.role.responsibilities")}>
              <TagInput
                aria-label={t("teams.role.responsibilities")}
                values={form.responsibilities}
                onChange={(responsibilities) => patch({ responsibilities })}
                placeholder={t("teams.role.responsibilitiesPlaceholder")}
              />
            </Field>

            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-[13px] font-medium text-ink-2">{t("teams.role.strengths")}</h3>
                  <p className="text-xs text-ink-3">{t("teams.role.strengthsHint")}</p>
                </div>
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => setStrengthRows((rows) => [...rows, { id: newId("str"), area: "", score: 3 }])}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  {t("teams.role.addStrength")}
                </Button>
              </div>
              <div className="space-y-2">
                {strengthRows.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center gap-3 rounded-xl border border-line bg-card-hover px-3 py-2.5"
                  >
                    <div className="w-52">
                      <Input
                        aria-label={t("teams.role.areaPlaceholder")}
                        list="member-strength-suggestions"
                        value={row.area}
                        onChange={(event) =>
                          setStrengthRows((rows) =>
                            rows.map((item) => (item.id === row.id ? { ...item, area: event.target.value } : item))
                          )
                        }
                        placeholder={t("teams.role.areaPlaceholder")}
                      />
                    </div>
                    <div className="flex flex-1 justify-center">
                      <ScoreDots
                        value={row.score}
                        onChange={(score) =>
                          setStrengthRows((rows) =>
                            rows.map((item) => (item.id === row.id ? { ...item, score: score || 3 } : item))
                          )
                        }
                        aria-label={row.area || t("teams.role.strengths")}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("common.remove")}
                      onClick={() => setStrengthRows((rows) => rows.filter((item) => item.id !== row.id))}
                    >
                      <Trash2 className="h-4 w-4 text-ink-3" aria-hidden />
                    </Button>
                  </div>
                ))}
                {strengthRows.length === 0 && (
                  <p className="rounded-xl border border-dashed border-line-strong px-3 py-4 text-center text-xs text-ink-3">
                    {t("common.none")}
                  </p>
                )}
              </div>
              <datalist id="member-strength-suggestions">
                {STRENGTH_AREA_KEYS.map((area) => (
                  <option key={area} value={t(`strengthAreas.${area}` as MessageKey)} />
                ))}
              </datalist>
            </section>

            <Field label={t("teams.role.limitations")}>
              <TagInput
                aria-label={t("teams.role.limitations")}
                values={form.limitations}
                onChange={(limitations) => patch({ limitations })}
                placeholder={t("teams.role.limitationsPlaceholder")}
              />
            </Field>

            <Field label={t("teams.role.systemInstructions")} htmlFor="role-instructions">
              <Textarea
                id="role-instructions"
                value={form.systemInstructions}
                onChange={(event) => patch({ systemInstructions: event.target.value })}
                placeholder={t("teams.role.systemInstructionsPlaceholder")}
              />
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}
