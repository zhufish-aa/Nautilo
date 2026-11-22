import { useId, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, CircleHelp, Loader2, Pencil, Plus, Trash2, Zap } from "lucide-react";
import type { DelegationPolicy } from "@agenthub/domain";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { providerMeta } from "../../lib/provider-catalog";
import { TASK_TYPE_KEYS, type TeamIssue, type UiTeam, type UiTeamMember } from "../../lib/types";
import { newId } from "../../lib/utils";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Input";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { Tooltip } from "../../components/ui/Tooltip";
import { useAgentsStore } from "../../stores/agents";
import { useConnectionsStore } from "../../stores/connections";
import { useTeamsStore } from "../../stores/teams";
import { toast } from "../../stores/toast";
import { MemberEditorDialog } from "./MemberEditorDialog";
import { persistTeamChange } from "./team-mutations";

const POLICIES: DelegationPolicy[] = ["autonomous", "ask_before_delegate", "direct_only"];

function TeamMemberRow({ member, pending, onToggle, onEdit, onRemove }: {
  member: UiTeamMember;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const instance = useAgentsStore(state => state.instances.find(item => item.id === member.agentInstanceId));
  const connection = useConnectionsStore(state => state.connections.find(item => item.id === member.connectionId));
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const role = member.role;
  const roleSummary = role.description.trim() || role.responsibilities[0] || role.name;
  const provider = instance ? providerMeta(instance.providerId).name : (zh ? "Harness 不可用" : "Harness unavailable");
  const account = connection?.name ?? (member.connectionId
    ? (zh ? "连接不可用" : "Connection unavailable")
    : (zh ? "未绑定账号" : "No account bound"));
  const model = member.model || (zh ? "默认模型" : "Default model");
  const route = [provider, account, model].join(" · ");
  const detailLabel = zh ? "成员详情" : "Member details";
  const details: Array<[string, string | undefined]> = [
    [t("teams.role.name"), role.name],
    [t("teams.role.description"), role.description],
    [t("teams.role.responsibilities"), role.responsibilities.join(" · ")],
    [t("teams.role.limitations"), role.limitations.join(" · ")],
    [t("teams.role.strengths"), Object.entries(role.strengths).map(([name, score]) => `${name} ${score}/5`).join(" · ")],
    [t("teams.role.permissionPolicy"), role.permissionPolicyId === "default" ? (zh ? "默认策略" : "Default policy") : role.permissionPolicyId],
    [t("teams.member.taskTypes"), member.allowedTaskTypes.map(type => (TASK_TYPE_KEYS as readonly string[]).includes(type)
      ? t(`taskTypes.${type}` as MessageKey) : type).join(" · ")],
    [t("teams.member.maxConcurrent"), member.maxConcurrentTasks?.toString()],
    [zh ? "推理强度" : "Reasoning effort", member.reasoningEffort],
    [zh ? "服务档位" : "Service tier", member.serviceTier],
    [zh ? "连接版本" : "Connection revision", member.connectionRevision?.toString()],
  ];
  const visibleDetails = details.filter(([, value]) => value?.trim());
  const hasDetails = visibleDetails.length > 0 || Boolean(role.systemInstructions.trim());

  return (
    <li className="team-roster-entry" data-enabled={member.enabled}>
      <div className="team-roster-row">
        <div className="team-roster-identity">
          <div className="team-roster-mark">
            <ProviderAvatar providerId={instance?.providerId ?? ""} size="sm" />
            <span className="team-state-dot" data-tone={member.enabled ? "ok" : "muted"} aria-hidden />
          </div>
          <div className="team-roster-name">
            <strong title={member.displayName}>{member.displayName}</strong>
            {roleSummary && <span title={roleSummary}>{roleSummary}</span>}
          </div>
        </div>
        <div className="team-roster-route" title={route}>
          <span>{provider}</span><span aria-hidden>·</span><span>{account}</span><span aria-hidden>·</span><strong>{model}</strong>
        </div>
        <div className="team-roster-actions">
          <Switch disabled={pending} checked={member.enabled} onCheckedChange={onToggle}
            aria-label={`${t("teams.member.enabled")} ${member.displayName}`} />
          {hasDetails && <Tooltip content={detailLabel}>
            <Button type="button" variant="ghost" size="icon" aria-expanded={expanded} aria-controls={detailsId}
              aria-label={`${detailLabel} ${member.displayName}`} onClick={() => setExpanded(open => !open)}>
              <ChevronDown size={15} aria-hidden />
            </Button>
          </Tooltip>}
          <Tooltip content={t("common.edit")}>
            <Button type="button" variant="ghost" size="icon" disabled={pending} aria-label={`${t("common.edit")} ${member.displayName}`} onClick={onEdit}>
              <Pencil size={14} aria-hidden />
            </Button>
          </Tooltip>
          <Tooltip content={t("teams.editor.remove")}>
            <Button type="button" variant="ghost" size="icon" className="team-risk-action" disabled={pending}
              aria-label={`${t("teams.editor.remove")} ${member.displayName}`} onClick={onRemove}>
              <Trash2 size={14} aria-hidden />
            </Button>
          </Tooltip>
        </div>
      </div>
      {hasDetails && <div className="team-roster-disclosure" data-open={expanded} id={detailsId} aria-hidden={!expanded}>
        <div>
          <div className="team-roster-details">
            <dl>
              {visibleDetails.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
            {role.systemInstructions.trim() && <div className="team-roster-instructions">
              <h4>{t("teams.role.systemInstructions")}</h4>
              <pre>{role.systemInstructions}</pre>
            </div>}
            <Button type="button" variant="outline" size="sm" disabled={pending} tabIndex={expanded ? 0 : -1} onClick={onEdit}>
              {zh ? "编辑此成员" : "Edit this member"}
            </Button>
          </div>
        </div>
      </div>}
    </li>
  );
}

export function TeamWorkbench({ team, issues, pending, setPending, onDelete }: {
  team: UiTeam;
  issues: TeamIssue[];
  pending: boolean;
  setPending: (pending: boolean) => void;
  onDelete: () => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const { updateTeam, deleteTeam, addMember, updateMember, removeMember } = useTeamsStore();
  const instances = useAgentsStore(state => state.instances);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<UiTeamMember>();
  const [confirmation, setConfirmation] = useState<"team" | UiTeamMember>();
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const enabled = team.members.filter(member => member.enabled);
  const roleSummary = [...new Set(team.members.map(({ role }) => role.description.trim() || role.name))].filter(Boolean).slice(0, 3).join(" · ");
  const routed = enabled.length > 0 && team.delegationPolicy !== "direct_only";
  const removing = typeof confirmation === "object" ? confirmation : undefined;
  const tone = issues[0]?.level ?? "ok";

  const mutate = async (action: () => Promise<void>, onSuccess?: () => void): Promise<void> => {
    if (pending || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      await persistTeamChange(team.id, action);
      onSuccess?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const openEditor = (member?: UiTeamMember): void => {
    setEditing(member);
    setError("");
    setEditorOpen(true);
  };
  const saveName = (): void => {
    if (name.trim()) void mutate(() => updateTeam(team.id, { name: name.trim() }), () => setRenameOpen(false));
  };
  const remove = (): void => {
    if (removing) {
      void mutate(() => removeMember(team.id, removing.id), () => setConfirmation(undefined));
    } else {
      void mutate(() => deleteTeam(team.id), () => {
        setConfirmation(undefined);
        toast.info(t("teams.editor.deletedToast", { name: team.name }));
        onDelete();
      });
    }
  };

  const failure = error && <p role="alert" className="team-operation-error">{error}</p>;
  const spinner = pending && <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden />;
  const addLabel = t("teams.editor.addMember");

  return (
    <div className="team-workbench">
      <header className="team-detail-heading">
        <div className="team-detail-copy">
          <div>
            <h2 title={team.name}>{team.name}</h2>
            <span className="team-state" data-tone={tone}><span className="team-state-dot" />
              {issues.length ? (zh ? "配置待修正" : "Needs attention") : (zh ? "就绪" : "Ready")}
            </span>
          </div>
          {roleSummary && <p title={roleSummary}>{zh ? "成员职责" : "Member roles"}<span aria-hidden> · </span>{roleSummary}</p>}
        </div>
        <div className="team-detail-actions">
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => {
            setName(team.name); setError(""); setRenameOpen(true);
          }}><Pencil size={14} aria-hidden />{t("common.edit")}</Button>
          <Button type="button" size="sm" variant="ghost" className="team-risk-action" disabled={pending} onClick={() => {
            setError(""); setConfirmation("team");
          }}><Trash2 size={14} aria-hidden />{t("teams.editor.deleteTeam")}</Button>
        </div>
      </header>
      {issues.length > 0 && <ul className="team-issues" aria-label={t("teams.editor.validationTitle")}>
        {issues.map(issue => <li key={issue.id} data-tone={issue.level}>
          <AlertTriangle size={14} aria-hidden /><span>{t(issue.textKey as MessageKey, issue.values)}</span>
        </li>)}
      </ul>}
      {!renameOpen && !confirmation && failure}

      <section className="team-topology" aria-label={zh ? "调度拓扑" : "Delegation flow"}>
        <div className="team-topology-track" data-active={routed}>
          <div className="team-topology-node team-topology-source">
            <Zap size={16} aria-hidden />
            <div><h3>{t("teams.card.main")}</h3><p>{zh ? "统筹拆解与汇总" : "Plans work and combines results"}</p></div>
          </div>
          <div className="team-topology-route">
            <SelectField value={team.delegationPolicy} disabled={pending} aria-label={t("teams.editor.policyTitle")}
              onValueChange={value => void mutate(() => updateTeam(team.id, { delegationPolicy: value as DelegationPolicy }))}
              options={POLICIES.map(policy => ({ value: policy, label: t(`teams.policy.${policy}` as MessageKey) }))} />
            <ChevronRight className="team-topology-arrow" size={13} aria-hidden />
          </div>
          <div className="team-topology-node team-topology-target">
            <div className="team-topology-target-heading">
              <h3>{zh ? "子 Agent 编队" : "Subagent team"}</h3>
              <span>{enabled.length}/{team.members.length} {zh ? "启用" : "enabled"}</span>
            </div>
            {enabled.length > 0 && <ul className="team-topology-members">
              {enabled.slice(0, 3).map(member => {
                const instance = instances.find(item => item.id === member.agentInstanceId);
                return <li key={member.id} title={member.displayName}>
                  {instance && <ProviderAvatar providerId={instance.providerId} size="sm" />}
                  <span>{member.displayName}</span>
                </li>;
              })}
              {enabled.length > 3 && <li>+{enabled.length - 3}</li>}
            </ul>}
          </div>
        </div>
        <p className="team-topology-description">
          {t(`teams.policy.${team.delegationPolicy}Desc` as MessageKey)}
          <Tooltip content={t("teams.editor.policyDesc")}>
            <button type="button" aria-label={t("teams.editor.policyDesc")}><CircleHelp size={14} aria-hidden /></button>
          </Tooltip>
        </p>
      </section>

      <section className="team-roster" aria-labelledby="team-roster-title">
        <header>
          <h3 id="team-roster-title">{zh ? "成员编排" : "Team members"}<span>{team.members.length}</span></h3>
          {team.members.length > 0 && <Button type="button" variant="outline" size="sm" className="team-add-member" disabled={pending} onClick={() => openEditor()}>
            <Plus size={14} aria-hidden />{addLabel}
          </Button>}
        </header>
        {team.members.length > 0 ? <ul className="team-roster-list">
          {team.members.map(member => <TeamMemberRow key={member.id} member={member} pending={pending}
            onToggle={value => void mutate(() => updateMember(team.id, member.id, { enabled: value }))}
            onEdit={() => openEditor(member)} onRemove={() => { setError(""); setConfirmation(member); }} />)}
        </ul> : <div className="team-roster-empty">
          <p>{zh ? "为主 Agent 添加可委派的成员。" : "Add a member the main agent can delegate to."}</p>
          <Button type="button" variant="outline" size="sm" className="team-add-member" disabled={pending} onClick={() => openEditor()}>
            <Plus size={14} aria-hidden />{zh ? "添加首位成员" : "Add the first member"}
          </Button>
        </div>}
      </section>

      <MemberEditorDialog open={editorOpen} onOpenChange={setEditorOpen} member={editing}
        onSave={draft => persistTeamChange(team.id, () => editing
          ? updateMember(team.id, editing.id, draft)
          : addMember(team.id, { ...draft, id: newId("member") }))} />

      <Dialog open={renameOpen} onOpenChange={value => { if (!pending) setRenameOpen(value); }}
        title={zh ? "编辑团队" : "Edit team"} widthClass="max-w-md team-dialog" footer={<>
          <Button variant="outline" disabled={pending} onClick={() => setRenameOpen(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={pending || !name.trim()} onClick={saveName}>{spinner}{t("common.save")}</Button>
        </>}>
        <Field label={t("teams.editor.nameLabel")} htmlFor="team-name">
          <Input id="team-name" value={name} disabled={pending} autoFocus onChange={event => setName(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); saveName(); } }} />
        </Field>
        {failure}
      </Dialog>

      <Dialog open={Boolean(confirmation)} onOpenChange={value => { if (!pending && !value) setConfirmation(undefined); }}
        title={t(removing ? "teams.editor.removeTitle" : "teams.editor.deleteTitle")}
        description={removing ? t("teams.editor.removeDesc", { name: removing.displayName }) : t("teams.editor.deleteDesc", { name: team.name })}
        widthClass="max-w-md team-dialog" footer={<>
          <Button variant="outline" disabled={pending} onClick={() => setConfirmation(undefined)}>{t("common.cancel")}</Button>
          <Button variant="danger" disabled={pending} onClick={remove}>{spinner}{t(removing ? "teams.editor.remove" : "teams.editor.deleteTeam")}</Button>
        </>}>
        {failure}
      </Dialog>
    </div>
  );
}
