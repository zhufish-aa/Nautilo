import { useCallback, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Loader2,
  Play,
  Plus,
  Save,
  ScrollText,
  ShieldCheck,
  Trash2
} from "lucide-react";
import type { CommandPolicyAction, CommandPolicyRule, PermissionPolicy } from "@agenthub/domain";
import { StatusChip } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { MotionCard } from "../../components/ui/Card";
import { Field, Input } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { TagInput } from "../../components/ui/TagInput";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { cn, newId } from "../../lib/utils";
import { toast } from "../../stores/toast";
import { EmptyHint, Panel, SectionHeader } from "./parts";

type RuleSource = "agent" | "verification" | "system";

interface EvaluationResult {
  action: CommandPolicyAction;
  ruleId?: string;
  reason: string;
}

const ACTIONS: CommandPolicyAction[] = ["safe", "approval", "blocked"];
const SOURCES: RuleSource[] = ["agent", "verification", "system"];

const ACTION_TONE: Record<CommandPolicyAction, "ok" | "warn" | "danger"> = {
  safe: "ok",
  approval: "warn",
  blocked: "danger"
};

function blankPolicy(): PermissionPolicy {
  return {
    id: newId("policy"),
    name: "",
    defaultCommandAction: "approval",
    commandRules: [],
    environmentAllowlist: [],
    allowedPaths: [],
    updatedAt: new Date().toISOString()
  };
}

/** Mirrors CommandPolicyService.evaluate for drafts not yet persisted in Core. */
function evaluateLocally(policy: PermissionPolicy, command: string, args: string[], source: RuleSource): EvaluationResult {
  const executable = (command.split(/[\\/]/).pop() ?? command).replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
  const rule = policy.commandRules.find((candidate) => {
    if (candidate.sources?.length && !candidate.sources.includes(source)) return false;
    if (candidate.executable && candidate.executable !== "*" && candidate.executable.toLowerCase() !== executable) return false;
    return !candidate.argsPrefix?.length || candidate.argsPrefix.every((value, index) => args[index]?.toLowerCase() === value.toLowerCase());
  });
  return { action: rule?.action ?? policy.defaultCommandAction, ruleId: rule?.id, reason: rule?.description ?? `Default ${policy.defaultCommandAction} policy` };
}

/** Real Core-backed permission policy management surface. */
export function PermissionPolicyCard(): JSX.Element {
  const { t } = useI18n();
  const [policies, setPolicies] = useState<PermissionPolicy[]>([]);
  const [draft, setDraft] = useState<PermissionPolicy | undefined>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testCommand, setTestCommand] = useState("");
  const [testArgs, setTestArgs] = useState("");
  const [testSource, setTestSource] = useState<RuleSource>("agent");
  const [testResult, setTestResult] = useState<EvaluationResult | undefined>();
  const [testing, setTesting] = useState(false);

  const load = useCallback(async (selectId?: string): Promise<void> => {
    setLoading(true);
    try {
      const list = await requestCore<PermissionPolicy[]>("policy.list");
      setPolicies(list);
      setDraft((current) => {
        const targetId = selectId ?? current?.id ?? "default";
        const found = list.find((policy) => policy.id === targetId) ?? list.find((policy) => policy.id === "default") ?? list[0];
        // Keep an unsaved new-policy draft instead of discarding it on refresh.
        if (current && !list.some((policy) => policy.id === current.id) && !selectId) return current;
        return found ? structuredClone(found) : undefined;
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const patch = (changes: Partial<PermissionPolicy>): void =>
    setDraft((current) => (current ? { ...current, ...changes } : current));

  const patchRule = (index: number, changes: Partial<CommandPolicyRule>): void =>
    setDraft((current) => {
      if (!current) return current;
      const commandRules = current.commandRules.map((rule, i) => (i === index ? { ...rule, ...changes } : rule));
      return { ...current, commandRules };
    });

  const addRule = (): void =>
    setDraft((current) => current && ({
      ...current,
      commandRules: [...current.commandRules, { id: newId("rule"), action: "approval" as const }]
    }));

  const removeRule = (index: number): void =>
    setDraft((current) => current && ({
      ...current,
      commandRules: current.commandRules.filter((_, i) => i !== index)
    }));

  const moveRule = (index: number, direction: -1 | 1): void =>
    setDraft((current) => {
      if (!current) return current;
      const target = index + direction;
      if (target < 0 || target >= current.commandRules.length) return current;
      const commandRules = [...current.commandRules];
      [commandRules[index], commandRules[target]] = [commandRules[target], commandRules[index]];
      return { ...current, commandRules };
    });

  const toggleRuleSource = (index: number, source: RuleSource): void => {
    const rule = draft?.commandRules[index];
    if (!rule) return;
    const current = rule.sources ?? [];
    const next = current.includes(source) ? current.filter((item) => item !== source) : [...current, source];
    patchRule(index, { sources: next.length ? next : undefined });
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    try {
      const payload: PermissionPolicy = {
        ...draft,
        name: draft.name.trim() || t("settings.policy.untitled"),
        updatedAt: new Date().toISOString()
      };
      await requestCore<PermissionPolicy>("policy.upsert", payload);
      toast.success(t("settings.policy.savedToast", { name: payload.name }));
      await load(payload.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const persistedPolicy = draft ? policies.find((policy) => policy.id === draft.id) : undefined;
  const dirty = !!draft && !!persistedPolicy
    && JSON.stringify({ ...persistedPolicy, updatedAt: "" }) !== JSON.stringify({ ...draft, updatedAt: "" });
  const unsaved = dirty || (!!draft && !persistedPolicy);

  const runTest = async (): Promise<void> => {
    if (!draft || !testCommand.trim()) return;
    setTesting(true);
    try {
      const args = testArgs.split(/\s+/).filter(Boolean);
      const useCore = !!persistedPolicy && !dirty;
      const result = useCore
        ? await requestCore<EvaluationResult>("policy.evaluate", { policyId: draft.id, command: testCommand.trim(), args, source: testSource })
        : evaluateLocally(draft, testCommand.trim(), args, testSource);
      setTestResult(result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  const actionLabel = (action: CommandPolicyAction): string =>
    action === "safe" ? t("settings.policy.actionSafe") : action === "approval" ? t("settings.policy.actionApproval") : t("settings.policy.actionBlocked");

  const sourceLabel = (source: RuleSource): string =>
    source === "agent" ? t("settings.policy.sourceAgent") : source === "verification" ? t("settings.policy.sourceVerification") : t("settings.policy.sourceSystem");

  const listedPolicies = draft && !policies.some((policy) => policy.id === draft.id) ? [...policies, draft] : policies;

  return (
    <MotionCard className="card-glow lg:col-span-2">
      <div className="p-5">
        <SectionHeader
          icon={ShieldCheck}
          title={t("settings.policy.title")}
          description={t("settings.policy.desc")}
          actions={
            <Button size="sm" variant="subtle" onClick={() => setDraft(blankPolicy())}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {t("settings.policy.newPolicy")}
            </Button>
          }
        />

        <div className="mt-4 grid gap-4 xl:grid-cols-[240px_1fr]">
          <Panel title={t("settings.policy.listTitle")} count={listedPolicies.length} className="self-start">
            <div className="space-y-1.5">
              {listedPolicies.length === 0 && !loading && <EmptyHint>{t("common.none")}</EmptyHint>}
              {listedPolicies.map((policy) => {
                const active = draft?.id === policy.id;
                return (
                  <button
                    key={policy.id}
                    type="button"
                    onClick={() => setDraft(structuredClone(policy))}
                    className={cn(
                      "group flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                      active
                        ? "border-accent/50 bg-accent-soft"
                        : "border-line bg-card hover:border-line-strong hover:bg-card-hover"
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border",
                        active ? "border-accent/25 bg-accent/10 text-accent" : "border-line bg-card-hover text-ink-3"
                      )}
                    >
                      <ScrollText className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-xs font-medium", active ? "text-accent" : "text-ink-2")}>
                        {policy.name || t("settings.policy.untitled")}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-ink-3">
                        {t("settings.policy.ruleCount", { count: policy.commandRules.length })}
                      </span>
                    </span>
                    {policy.id === "default" && (
                      <span className="shrink-0 rounded-md bg-line/50 px-1.5 py-0.5 text-[11px] text-ink-3">
                        {t("settings.policy.defaultBadge")}
                      </span>
                    )}
                    <ChevronRight
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 transition-opacity",
                        active ? "text-accent" : "text-ink-3 opacity-0 group-hover:opacity-70"
                      )}
                      aria-hidden
                    />
                  </button>
                );
              })}
            </div>
          </Panel>

          {draft && (
            <div className="space-y-4">
              <Panel>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label={t("settings.policy.nameLabel")} htmlFor="policy-name">
                    <Input
                      id="policy-name"
                      value={draft.name}
                      onChange={(event) => patch({ name: event.target.value })}
                      placeholder={t("settings.policy.namePlaceholder")}
                    />
                  </Field>
                  <Field label={t("settings.policy.defaultAction")}>
                    <SelectField
                      aria-label={t("settings.policy.defaultAction")}
                      value={draft.defaultCommandAction}
                      onValueChange={(value) => patch({ defaultCommandAction: value as CommandPolicyAction })}
                      options={ACTIONS.map((action) => ({ value: action, label: actionLabel(action) }))}
                    />
                  </Field>
                </div>

                <div className="mt-4 border-t border-line pt-4">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-[13px] font-semibold text-ink">{t("settings.policy.rulesTitle")}</h3>
                      <p className="text-xs text-ink-3">{t("settings.policy.rulesHint")}</p>
                    </div>
                    <Button variant="subtle" size="sm" onClick={addRule}>
                      <Plus className="h-3.5 w-3.5" aria-hidden />
                      {t("settings.policy.addRule")}
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {draft.commandRules.map((rule, index) => (
                      <div
                        key={rule.id}
                        className="rounded-lg border border-line bg-card p-3 transition-colors hover:border-line-strong"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className="flex h-9.5 w-6 shrink-0 items-center justify-center rounded-md bg-line/40 font-mono text-[11px] font-medium text-ink-3"
                            aria-hidden
                          >
                            {index + 1}
                          </span>
                          <div className="w-32 shrink-0">
                            <SelectField
                              aria-label={t("settings.policy.defaultAction")}
                              value={rule.action}
                              onValueChange={(value) => patchRule(index, { action: value as CommandPolicyAction })}
                              options={ACTIONS.map((action) => ({ value: action, label: actionLabel(action) }))}
                            />
                          </div>
                          <div className="w-40 shrink-0">
                            <Input
                              aria-label={t("settings.policy.ruleExecutablePlaceholder")}
                              value={rule.executable ?? ""}
                              onChange={(event) => patchRule(index, { executable: event.target.value.trim() || undefined })}
                              placeholder={t("settings.policy.ruleExecutablePlaceholder")}
                              className="font-mono text-[13px]"
                            />
                          </div>
                          <Input
                            aria-label={t("settings.policy.ruleArgsPrefixPlaceholder")}
                            value={rule.argsPrefix?.join(", ") ?? ""}
                            onChange={(event) => {
                              const argsPrefix = event.target.value.split(",").map((value) => value.trim()).filter(Boolean);
                              patchRule(index, { argsPrefix: argsPrefix.length ? argsPrefix : undefined });
                            }}
                            placeholder={t("settings.policy.ruleArgsPrefixPlaceholder")}
                            className="min-w-40 flex-1 font-mono text-[13px]"
                          />
                          <div className="flex items-center gap-0.5">
                            <Button variant="ghost" size="icon" aria-label={t("settings.policy.moveUp")} disabled={index === 0} onClick={() => moveRule(index, -1)}>
                              <ArrowUp className="h-4 w-4" aria-hidden />
                            </Button>
                            <Button variant="ghost" size="icon" aria-label={t("settings.policy.moveDown")} disabled={index === draft.commandRules.length - 1} onClick={() => moveRule(index, 1)}>
                              <ArrowDown className="h-4 w-4" aria-hidden />
                            </Button>
                            <Button variant="ghost" size="icon" aria-label={t("common.remove")} onClick={() => removeRule(index)}>
                              <Trash2 className="h-4 w-4 text-ink-3" aria-hidden />
                            </Button>
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 pl-8">
                          <div className="flex items-center gap-1.5" role="group" aria-label={t("settings.policy.testerSource")}>
                            {SOURCES.map((source) => {
                              const active = rule.sources?.includes(source) ?? false;
                              return (
                                <button
                                  key={source}
                                  type="button"
                                  aria-pressed={active}
                                  onClick={() => toggleRuleSource(index, source)}
                                  className={cn(
                                    "h-7 rounded-lg border px-2.5 text-xs font-medium transition-all duration-150 outline-none",
                                    "focus-visible:ring-2 focus-visible:ring-accent/70",
                                    active ? "border-accent/50 bg-accent-soft text-accent" : "border-line bg-card text-ink-3 hover:border-line-strong hover:text-ink-2"
                                  )}
                                >
                                  {sourceLabel(source)}
                                </button>
                              );
                            })}
                          </div>
                          <Input
                            aria-label={t("settings.policy.ruleDescriptionPlaceholder")}
                            value={rule.description ?? ""}
                            onChange={(event) => patchRule(index, { description: event.target.value || undefined })}
                            placeholder={t("settings.policy.ruleDescriptionPlaceholder")}
                            className="min-w-48 flex-1 text-[13px]"
                          />
                        </div>
                      </div>
                    ))}
                    {draft.commandRules.length === 0 && <EmptyHint>{t("common.none")}</EmptyHint>}
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-2">
                  <Field label={t("settings.policy.envAllowlist")}>
                    <TagInput
                      aria-label={t("settings.policy.envAllowlist")}
                      values={draft.environmentAllowlist}
                      onChange={(environmentAllowlist) => patch({ environmentAllowlist })}
                      placeholder={t("settings.policy.envAllowlistPlaceholder")}
                    />
                  </Field>
                  <Field label={t("settings.policy.allowedPaths")}>
                    <TagInput
                      aria-label={t("settings.policy.allowedPaths")}
                      values={draft.allowedPaths}
                      onChange={(allowedPaths) => patch({ allowedPaths })}
                      placeholder={t("settings.policy.allowedPathsPlaceholder")}
                    />
                  </Field>
                </div>

                <div className="mt-4 flex items-center justify-end gap-3 border-t border-line pt-4">
                  {unsaved && <StatusChip tone="warn" label={t("settings.policy.dirtyBadge")} />}
                  <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving}>
                    {saving
                      ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
                      : <Save className="h-3.5 w-3.5" aria-hidden />}
                    {t("settings.policy.save")}
                  </Button>
                </div>
              </Panel>

              <Panel icon={Play} title={t("settings.policy.testerTitle")}>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="w-44 shrink-0">
                    <Input
                      aria-label={t("settings.policy.testerCommandPlaceholder")}
                      value={testCommand}
                      onChange={(event) => setTestCommand(event.target.value)}
                      placeholder={t("settings.policy.testerCommandPlaceholder")}
                      className="font-mono text-[13px]"
                    />
                  </div>
                  <Input
                    aria-label={t("settings.policy.testerArgsPlaceholder")}
                    value={testArgs}
                    onChange={(event) => setTestArgs(event.target.value)}
                    placeholder={t("settings.policy.testerArgsPlaceholder")}
                    className="min-w-48 flex-1 font-mono text-[13px]"
                  />
                  <div className="w-32 shrink-0">
                    <SelectField
                      aria-label={t("settings.policy.testerSource")}
                      value={testSource}
                      onValueChange={(value) => setTestSource(value as RuleSource)}
                      options={SOURCES.map((source) => ({ value: source, label: sourceLabel(source) }))}
                    />
                  </div>
                  <Button size="sm" onClick={() => void runTest()} disabled={testing || !testCommand.trim()}>
                    {testing
                      ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
                      : <Play className="h-3.5 w-3.5" aria-hidden />}
                    {t("settings.policy.testerRun")}
                  </Button>
                </div>
                <div className="mt-3">
                  {testResult ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-card px-3 py-2">
                      <StatusChip tone={ACTION_TONE[testResult.action]} label={actionLabel(testResult.action)} />
                      <span className="text-xs text-ink-3">{testResult.reason}</span>
                    </div>
                  ) : (
                    <p className="text-xs text-ink-3">{t("settings.policy.testerEmpty")}</p>
                  )}
                </div>
              </Panel>
            </div>
          )}
        </div>
      </div>
    </MotionCard>
  );
}
