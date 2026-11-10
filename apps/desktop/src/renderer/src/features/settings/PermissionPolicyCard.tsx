import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Loader2,
  HelpCircle,
  Play,
  Plus,
  Save,
  Search,
  Pencil,
  Folder,
  X,
  MoreHorizontal,
  Check,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type {
  CommandPolicyAction,
  CommandPolicyRule,
  PermissionPolicy,
} from "@agenthub/domain";
import { StatusChip } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { Tooltip } from "../../components/ui/Tooltip";
import { TagInput } from "../../components/ui/TagInput";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { cn, newId } from "../../lib/utils";
import { toast } from "../../stores/toast";
import { EmptyHint } from "./parts";
import "./permission-policy.css";

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
  blocked: "danger",
};

function blankPolicy(): PermissionPolicy {
  return {
    id: newId("policy"),
    name: "",
    defaultCommandAction: "approval",
    commandRules: [],
    environmentAllowlist: [],
    allowedPaths: [],
    updatedAt: new Date().toISOString(),
  };
}

/** Mirrors CommandPolicyService.evaluate for drafts not yet persisted in Core. */
function evaluateLocally(
  policy: PermissionPolicy,
  command: string,
  args: string[],
  source: RuleSource,
): EvaluationResult {
  const executable = (command.split(/[\\/]/).pop() ?? command)
    .replace(/\.(?:exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();
  const rule = policy.commandRules.find((candidate) => {
    if (candidate.sources?.length && !candidate.sources.includes(source))
      return false;
    if (
      candidate.executable &&
      candidate.executable !== "*" &&
      candidate.executable.toLowerCase() !== executable
    )
      return false;
    return (
      !candidate.argsPrefix?.length ||
      candidate.argsPrefix.every(
        (value, index) => args[index]?.toLowerCase() === value.toLowerCase(),
      )
    );
  });
  return {
    action: rule?.action ?? policy.defaultCommandAction,
    ruleId: rule?.id,
    reason:
      rule?.description ?? `Default ${policy.defaultCommandAction} policy`,
  };
}

/** Real Core-backed permission policy management surface. */
export function PermissionPolicyCard(): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const [query, setQuery] = useState("");
  const [activeSection, setActiveSection] = useState("rules");
  const surface = useRef<HTMLElement>(null);
  const [policies, setPolicies] = useState<PermissionPolicy[]>([]);
  const [draft, setDraft] = useState<PermissionPolicy | undefined>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testCommand, setTestCommand] = useState("");
  const [testArgs, setTestArgs] = useState("");
  const [testSource, setTestSource] = useState<RuleSource>("agent");
  const [testResult, setTestResult] = useState<EvaluationResult | undefined>();
  const [testing, setTesting] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [newPath, setNewPath] = useState("");
  const pathInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (selectId?: string): Promise<void> => {
    setLoading(true);
    try {
      const list = await requestCore<PermissionPolicy[]>("policy.list");
      setPolicies(list);
      setDraft((current) => {
        const targetId = selectId ?? current?.id ?? "default";
        const found =
          list.find((policy) => policy.id === targetId) ??
          list.find((policy) => policy.id === "default") ??
          list[0];
        // Keep an unsaved new-policy draft instead of discarding it on refresh.
        if (
          current &&
          !list.some((policy) => policy.id === current.id) &&
          !selectId
        )
          return current;
        return found ? structuredClone(found) : undefined;
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setTestResult(undefined);
  }, [draft, testCommand, testArgs, testSource]);

  const patch = (changes: Partial<PermissionPolicy>): void =>
    setDraft((current) => (current ? { ...current, ...changes } : current));

  const patchRule = (
    index: number,
    changes: Partial<CommandPolicyRule>,
  ): void =>
    setDraft((current) => {
      if (!current) return current;
      const commandRules = current.commandRules.map((rule, i) =>
        i === index ? { ...rule, ...changes } : rule,
      );
      return { ...current, commandRules };
    });

  const addRule = (): void =>
    setDraft(
      (current) =>
        current && {
          ...current,
          commandRules: [
            ...current.commandRules,
            { id: newId("rule"), action: "approval" as const },
          ],
        },
    );

  const removeRule = (index: number): void =>
    setDraft(
      (current) =>
        current && {
          ...current,
          commandRules: current.commandRules.filter((_, i) => i !== index),
        },
    );

  const moveRule = (index: number, direction: -1 | 1): void =>
    setDraft((current) => {
      if (!current) return current;
      const target = index + direction;
      if (target < 0 || target >= current.commandRules.length) return current;
      const commandRules = [...current.commandRules];
      [commandRules[index], commandRules[target]] = [
        commandRules[target],
        commandRules[index],
      ];
      return { ...current, commandRules };
    });

  const toggleRuleSource = (index: number, source: RuleSource): void => {
    const rule = draft?.commandRules[index];
    if (!rule) return;
    const current = rule.sources ?? [];
    const next = current.includes(source)
      ? current.filter((item) => item !== source)
      : [...current, source];
    patchRule(index, { sources: next.length ? next : undefined });
  };

  const save = async (): Promise<void> => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      const payload: PermissionPolicy = {
        ...draft,
        name: draft.name.trim() || t("settings.policy.untitled"),
        updatedAt: new Date().toISOString(),
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

  const persistedPolicy = draft
    ? policies.find((policy) => policy.id === draft.id)
    : undefined;
  const dirty =
    !!draft &&
    !!persistedPolicy &&
    JSON.stringify({ ...persistedPolicy, updatedAt: "" }) !==
      JSON.stringify({ ...draft, updatedAt: "" });
  const unsaved = dirty || (!!draft && !persistedPolicy);

  const runTest = async (): Promise<void> => {
    if (!draft || !testCommand.trim()) return;
    setTesting(true);
    try {
      const args = testArgs.split(/\s+/).filter(Boolean);
      const useCore = !!persistedPolicy && !dirty;
      const result = useCore
        ? await requestCore<EvaluationResult>("policy.evaluate", {
            policyId: draft.id,
            command: testCommand.trim(),
            args,
            source: testSource,
          })
        : evaluateLocally(draft, testCommand.trim(), args, testSource);
      setTestResult(result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  const actionLabel = (action: CommandPolicyAction): string =>
    action === "safe"
      ? t("settings.policy.actionSafe")
      : action === "approval"
        ? t("settings.policy.actionApproval")
        : t("settings.policy.actionBlocked");

  const sourceLabel = (source: RuleSource): string =>
    source === "agent"
      ? t("settings.policy.sourceAgent")
      : source === "verification"
        ? t("settings.policy.sourceVerification")
        : t("settings.policy.sourceSystem");

  const listedPolicies =
    draft && !policies.some((policy) => policy.id === draft.id)
      ? [...policies, draft]
      : policies;

  const policyName = (policy: PermissionPolicy): string => zh && policy.id === "default" && policy.name === "Default local safety policy" ? "默认安全策略" : policy.name || t("settings.policy.untitled");
  const addPath = (): void => {
    const value = newPath.trim();
    if (!draft || !value) return;
    if (!draft.allowedPaths.includes(value)) patch({ allowedPaths: [...draft.allowedPaths, value] });
    setNewPath("");
  };

  const jump = (section: string): void => { setActiveSection(section); surface.current?.querySelector(`[data-policy-section="${section}"]`)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "nearest" }); };
  return <section className="policy-workspace" ref={surface} aria-busy={loading} data-design-frame="wKIWyUaqck">
    <header className="policy-page-heading"><h2>{zh ? "权限与安全" : "Permissions & safety"}</h2><Button size="sm" disabled={saving} onClick={() => setDraft(blankPolicy())}><Plus size={14}/>{t("settings.policy.newPolicy")}</Button></header>
    <div className="policy-layout">
      <aside className="policy-navigation"><label className="policy-search"><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder={zh ? "搜索策略" : "Search policies"} aria-label={zh ? "搜索策略" : "Search policies"}/></label>
        <div className="policy-list">{listedPolicies.filter(policy => `${policyName(policy)} ${policy.name}`.toLowerCase().includes(query.toLowerCase())).map(policy => <button type="button" key={policy.id} className="policy-list-item" aria-current={draft?.id === policy.id ? "true" : undefined} disabled={saving} onClick={() => { setDraft(structuredClone(policy)); setActiveSection("rules"); setEditingName(false); }}><span><strong>{policyName(policy)}</strong>{policy.id === "default" && <span className="policy-badge">{t("settings.policy.defaultBadge")}</span>}</span><small>{policy.commandRules.length} {zh ? "条命令规则" : "command rules"}</small></button>)}</div>
        {loading && <Loader2 size={17} className="animate-spin"/>}
      </aside>
      {draft ? <fieldset disabled={saving} className="policy-editor">
        <header className="policy-editor-heading"><div className="policy-title">{editingName ? <Input autoFocus value={draft.name} aria-label={t("settings.policy.nameLabel")} placeholder={t("settings.policy.namePlaceholder")} onChange={event => patch({ name: event.target.value })} onBlur={() => setEditingName(false)} onKeyDown={event => { if (event.key === "Enter") setEditingName(false); }}/> : <button type="button" title={zh ? "编辑策略名称" : "Edit policy name"} onClick={() => setEditingName(true)}><h3>{policyName(draft)}</h3></button>}{draft.id === "default" && <span className="policy-badge"><ShieldCheck size={11}/>{t("settings.policy.defaultBadge")}</span>}</div><details className="policy-heading-options"><summary aria-label={zh ? "策略选项" : "Policy options"}><MoreHorizontal size={17}/></summary><div><label>{zh ? "默认动作" : "Default action"}<SelectField value={draft.defaultCommandAction} aria-label={t("settings.policy.defaultAction")} onValueChange={value => patch({ defaultCommandAction: value as CommandPolicyAction })} options={ACTIONS.map(action => ({ value: action, label: actionLabel(action) }))}/></label></div></details></header>
        <nav className="policy-section-tabs" aria-label={zh ? "策略内容" : "Policy sections"}><button type="button" aria-current={activeSection === "rules" ? "page" : undefined} onClick={() => jump("rules")}>{t("settings.policy.rulesTitle")}<span>{draft.commandRules.length}</span></button><button type="button" aria-current={activeSection === "environment" ? "page" : undefined} onClick={() => jump("environment")}>{zh ? "环境与路径" : "Environment & paths"}</button><button type="button" aria-current={activeSection === "test" ? "page" : undefined} onClick={() => jump("test")}>{t("settings.policy.testerTitle")}</button></nav>
        <div className="policy-editor-body">
          <section data-policy-section="rules"><div className="policy-section-heading"><div><h3>{t("settings.policy.rulesTitle")}</h3><Tooltip content={t("settings.policy.rulesHint")}><button type="button" aria-label={t("settings.policy.rulesHint")}><HelpCircle size={14}/></button></Tooltip></div><Button variant="subtle" size="sm" onClick={addRule}><Plus size={14}/>{t("settings.policy.addRule")}</Button></div>
            <div className="policy-rules" role="table" aria-label={t("settings.policy.rulesTitle")}><div className="policy-rule-labels" role="row"><span/><span>{zh ? "动作" : "Action"}</span><span>{zh ? "命令" : "Command"}</span><span>{zh ? "参数" : "Arguments"}</span><span/></div>
              {draft.commandRules.map((rule, index) => <div className="policy-rule" role="row" key={rule.id}><span className="policy-rule-number">{String(index + 1).padStart(2, "0")}</span><div data-action={rule.action}><SelectField value={rule.action} aria-label={`${zh ? "规则" : "Rule"} ${index + 1} ${zh ? "动作" : "action"}`} onValueChange={value => patchRule(index, { action: value as CommandPolicyAction })} options={ACTIONS.map(action => ({ value: action, label: actionLabel(action) }))}/></div>
                <Input aria-label={t("settings.policy.ruleExecutablePlaceholder")} value={rule.executable ?? ""} placeholder="*" onChange={event => patchRule(index, { executable: event.target.value.trim() || undefined })}/>
                <Input aria-label={t("settings.policy.ruleArgsPrefixPlaceholder")} value={rule.argsPrefix?.join(", ") ?? ""} placeholder="—" onChange={event => { const argsPrefix = event.target.value.split(",").map(value => value.trim()).filter(Boolean); patchRule(index, { argsPrefix: argsPrefix.length ? argsPrefix : undefined }); }}/>
                <div className="policy-rule-actions"><button type="button" title={zh ? "编辑规则" : "Edit rule"} aria-label={zh ? "编辑规则" : "Edit rule"} onClick={event => event.currentTarget.closest(".policy-rule")?.querySelector<HTMLInputElement>("input")?.focus()}><Pencil size={13}/></button><details><summary title={zh ? "规则选项" : "Rule options"} aria-label={zh ? "规则选项" : "Rule options"}><MoreHorizontal size={15}/></summary><div className="policy-rule-options"><div className="policy-move-options"><button type="button" disabled={index === 0} onClick={() => moveRule(index, -1)}><ArrowUp size={13}/>{t("settings.policy.moveUp")}</button><button type="button" disabled={index === draft.commandRules.length - 1} onClick={() => moveRule(index, 1)}><ArrowDown size={13}/>{t("settings.policy.moveDown")}</button></div><div className="policy-source-options" role="group" aria-label={t("settings.policy.testerSource")}>{SOURCES.map(source => <button key={source} type="button" aria-pressed={rule.sources?.includes(source) ?? false} onClick={() => toggleRuleSource(index, source)}>{sourceLabel(source)}</button>)}</div><Input value={rule.description ?? ""} aria-label={t("settings.policy.ruleDescriptionPlaceholder")} placeholder={t("settings.policy.ruleDescriptionPlaceholder")} onChange={event => patchRule(index, { description: event.target.value || undefined })}/><button className="policy-delete-rule" type="button" onClick={() => removeRule(index)}><Trash2 size={13}/>{t("common.remove")}</button></div></details></div>
              </div>)}
              {!draft.commandRules.length && <EmptyHint>{t("common.none")}</EmptyHint>}
            </div>
          </section>
          <section data-policy-section="environment" className="policy-environment"><Field label={t("settings.policy.envAllowlist")} className="policy-environment-tags"><TagInput aria-label={t("settings.policy.envAllowlist")} values={draft.environmentAllowlist} onChange={environmentAllowlist => patch({ environmentAllowlist })} placeholder={t("settings.policy.envAllowlistPlaceholder")}/></Field><div className="policy-paths"><div className="policy-path-heading"><h3>{t("settings.policy.allowedPaths")}</h3><button type="button" onClick={() => pathInput.current?.focus()}><Plus size={13}/>{zh ? "添加路径" : "Add path"}</button></div>{draft.allowedPaths.map((path, index) => <div key={index} className="policy-path-row"><Folder size={14}/><input aria-label={`${zh ? "路径" : "Path"} ${index + 1}`} value={path} onChange={event => patch({ allowedPaths: draft.allowedPaths.map((value, at) => at === index ? event.target.value : value) })}/><button type="button" aria-label={`${t("common.remove")} ${path}`} onClick={() => patch({ allowedPaths: draft.allowedPaths.filter((_, at) => at !== index) })}><X size={13}/></button></div>)}<input ref={pathInput} className="policy-add-path" value={newPath} aria-label={zh ? "添加允许访问路径" : "Add allowed path"} placeholder={t("settings.policy.allowedPathsPlaceholder")} onChange={event => setNewPath(event.target.value)} onBlur={addPath} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); addPath(); } }}/></div></section>
          <section data-policy-section="test" className="policy-command-test"><h3>{t("settings.policy.testerTitle")}</h3><div className="policy-test-fields"><Input value={testCommand} onChange={event => setTestCommand(event.target.value)} aria-label={t("settings.policy.testerCommandPlaceholder")} placeholder={t("settings.policy.testerCommandPlaceholder")}/><Input value={testArgs} onChange={event => setTestArgs(event.target.value)} aria-label={t("settings.policy.testerArgsPlaceholder")} placeholder={t("settings.policy.testerArgsPlaceholder")}/><SelectField value={testSource} onValueChange={value => setTestSource(value as RuleSource)} options={SOURCES.map(source => ({ value: source, label: sourceLabel(source) }))} aria-label={t("settings.policy.testerSource")}/><Button size="sm" onClick={() => void runTest()} disabled={testing || !testCommand.trim()}>{testing ? <Loader2 size={13} className="animate-spin"/> : <Play size={13}/>} {t("settings.policy.testerRun")}</Button></div>{testResult && <div className="policy-test-result" role="status"><StatusChip tone={ACTION_TONE[testResult.action]} label={actionLabel(testResult.action)}/><span>{testResult.reason}</span></div>}</section>
        </div>
        <footer className="policy-savebar"><span>{unsaved ? t("settings.policy.dirtyBadge") : <><Check size={13}/>{zh ? "已保存" : "Saved"}</>}</span><div><Button size="sm" variant="ghost" onClick={() => { if (persistedPolicy) setDraft(structuredClone(persistedPolicy)); else setDraft(blankPolicy()); }} disabled={saving || !unsaved}>{zh ? "还原更改" : "Reset changes"}</Button><Button variant="primary" size="sm" onClick={() => void save()} disabled={saving}>{saving ? <Loader2 size={13} className="animate-spin"/> : <Save size={13}/>} {t("settings.policy.save")}</Button></div></footer>
      </fieldset> : <div className="policy-empty">{loading ? <Loader2 size={20} className="animate-spin"/> : t("common.none")}</div>}
    </div>
  </section>;
}
