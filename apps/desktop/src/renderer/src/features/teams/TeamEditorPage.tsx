import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Info,
  OctagonAlert,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Users
} from "lucide-react";
import type { DelegationPolicy } from "@agenthub/domain";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { providerMeta } from "../../lib/provider-catalog";
import type { TeamIssue, UiTeamMember } from "../../lib/types";
import { newId } from "../../lib/utils";
import { Card, MotionCard, StaggerGroup } from "../../components/ui/Card";
import { StatusChip, Tag } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Input } from "../../components/ui/Input";
import { ScoreDots } from "../../components/ui/ScoreDots";
import { Switch } from "../../components/ui/Switch";
import { useTeamsStore, validateTeam } from "../../stores/teams";
import { useAgentsStore } from "../../stores/agents";
import { toast } from "../../stores/toast";
import { MemberEditorDialog } from "./MemberEditorDialog";

const POLICIES: DelegationPolicy[] = ["autonomous", "ask_before_delegate", "direct_only"];

const issueStyles: Record<TeamIssue["level"], { icon: typeof Info; color: string }> = {
  critical: { icon: OctagonAlert, color: "text-danger" },
  warning: { icon: AlertTriangle, color: "text-warn" },
  info: { icon: Info, color: "text-info" }
};

function MemberCard({
  teamId,
  member,
  onEdit,
  onRemove
}: {
  teamId: string;
  member: UiTeamMember;
  onEdit: (member: UiTeamMember) => void;
  onRemove: (member: UiTeamMember) => void;
}): JSX.Element {
  const { t } = useI18n();
  const updateMember = useTeamsStore((state) => state.updateMember);
  const instance = useAgentsStore((state) =>
    state.instances.find((item) => item.id === member.agentInstanceId)
  );
  const meta = instance ? providerMeta(instance.providerId) : undefined;
  const strengthEntries = Object.entries(member.role.strengths).slice(0, 3);

  return (
    <MotionCard className="flex flex-col gap-3.5 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-gradient-to-br from-violet-500/25 to-fuchsia-500/15 text-violet-400"
          >
            <Bot className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-[15px] font-semibold text-ink">{member.displayName}</h3>
            </div>
            <p className="truncate text-xs text-ink-3">
              {member.role.name}
              {member.role.description ? ` · ${member.role.description}` : ""}
            </p>
          </div>
        </div>
        <Switch
          checked={member.enabled}
          onCheckedChange={(checked) => updateMember(teamId, member.id, { enabled: checked })}
          aria-label={`${member.displayName}: ${member.enabled ? t("common.enabled") : t("common.disabled")}`}
        />
      </div>

      {/* Provider comes from the reusable CLI connection; execution defaults belong to this member. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {meta && <Tag label={meta.name} />}
        <Tag label={member.model ?? t("agents.instances.defaultModel")} className="font-mono" />
        {member.reasoningEffort && <Tag label={member.reasoningEffort} className="font-mono" />}
        {!instance && <Tag label={t("teams.validation.instanceMissing", { name: "" }).replace("「」", "")} />}
      </div>

      {strengthEntries.length > 0 && (
        <ul className="space-y-1">
          {strengthEntries.map(([area, score]) => (
            <li key={area} className="flex items-center justify-between gap-3 text-[13px]">
              <span className="truncate text-ink-2">{area}</span>
              <ScoreDots value={score} aria-label={`${area} ${score}/5`} />
            </li>
          ))}
        </ul>
      )}

      {member.allowedTaskTypes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {member.allowedTaskTypes.map((taskType) => (
            <Tag key={taskType} label={t(`taskTypes.${taskType}` as MessageKey)} />
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3">
        <StatusChip tone={member.enabled ? "ok" : "muted"} label={member.enabled ? t("common.enabled") : t("common.disabled")} />
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="icon" aria-label={t("common.edit")} onClick={() => onEdit(member)}>
            <Pencil className="h-4 w-4" aria-hidden />
          </Button>
          <Button variant="ghost" size="icon" aria-label={t("teams.editor.remove")} onClick={() => onRemove(member)}>
            <Trash2 className="h-4 w-4 text-danger" aria-hidden />
          </Button>
        </div>
      </div>
    </MotionCard>
  );
}

export function TeamEditorPage(): JSX.Element {
  const { t } = useI18n();
  const { teamId } = useParams<{ teamId: string }>();
  const navigate = useNavigate();
  const team = useTeamsStore((state) => state.teams.find((item) => item.id === teamId));
  const updateTeam = useTeamsStore((state) => state.updateTeam);
  const deleteTeam = useTeamsStore((state) => state.deleteTeam);
  const addMember = useTeamsStore((state) => state.addMember);
  const updateMember = useTeamsStore((state) => state.updateMember);
  const removeMember = useTeamsStore((state) => state.removeMember);
  const instances = useAgentsStore((state) => state.instances);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<UiTeamMember | undefined>();
  const [removing, setRemoving] = useState<UiTeamMember | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const issues = useMemo(() => (team ? validateTeam(team, instances) : []), [team, instances]);

  if (!team) {
    return (
      <EmptyState
        icon={Users}
        title={t("teams.title")}
        description={t("teams.empty.desc")}
        action={
          <Button variant="outline" onClick={() => navigate("/teams")}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {t("teams.editor.back")}
          </Button>
        }
      />
    );
  }

  const openCreate = (): void => {
    setEditing(undefined);
    setEditorOpen(true);
  };
  const openEdit = (member: UiTeamMember): void => {
    setEditing(member);
    setEditorOpen(true);
  };
  const handleSave = (draft: Omit<UiTeamMember, "id">): void => {
    if (editing) {
      updateMember(team.id, editing.id, draft);
    } else {
      addMember(team.id, { ...draft, id: newId("member") });
    }
  };
  const handleRemove = (): void => {
    if (!removing) return;
    removeMember(team.id, removing.id);
    toast.info(t("teams.editor.removeDesc", { name: removing.displayName }));
    setRemoving(undefined);
  };
  const handleDelete = (): void => {
    deleteTeam(team.id);
    toast.info(t("teams.editor.deletedToast", { name: team.name }));
    navigate("/teams");
  };

  return (
    <>
      <button
        onClick={() => navigate("/teams")}
        className="mb-4 inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[13px] text-ink-3 transition-colors hover:bg-accent-soft hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t("teams.editor.back")}
      </button>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <label htmlFor="team-name" className="mb-1.5 block text-xs font-medium text-ink-3">
            {t("teams.editor.nameLabel")}
          </label>
          <Input
            id="team-name"
            value={team.name}
            onChange={(event) => updateTeam(team.id, { name: event.target.value })}
            placeholder={t("teams.editor.namePlaceholder")}
            className="max-w-md text-lg font-semibold"
          />
        </div>
        <Button variant="danger" onClick={() => setConfirmDelete(true)}>
          <Trash2 className="h-4 w-4" aria-hidden />
          {t("teams.editor.deleteTeam")}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-ink">{t("teams.editor.policyTitle")}</h2>
            <p className="mt-0.5 mb-4 text-xs text-ink-3">{t("teams.editor.policyDesc")}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" role="radiogroup" aria-label={t("teams.editor.policyTitle")}>
              {POLICIES.map((policy) => {
                const active = team.delegationPolicy === policy;
                return (
                  <button
                    key={policy}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => updateTeam(team.id, { delegationPolicy: policy })}
                    className={`rounded-xl border p-3.5 text-left transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-accent/70 ${
                      active
                        ? "border-accent/60 bg-accent-soft/60 shadow-glow"
                        : "border-line bg-card hover:border-accent/40 hover:bg-card-hover"
                    }`}
                  >
                    <p className={`text-sm font-medium ${active ? "text-accent" : "text-ink"}`}>
                      {t(`teams.policy.${policy}` as MessageKey)}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-ink-3">
                      {t(`teams.policy.${policy}Desc` as MessageKey)}
                    </p>
                  </button>
                );
              })}
            </div>
          </Card>

          <div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-ink">{t("teams.editor.membersTitle")}</h2>
                <p className="mt-0.5 text-xs text-ink-3">{t("teams.editor.membersDesc")}</p>
              </div>
              <Button variant="primary" size="sm" onClick={openCreate}>
                <Plus className="h-4 w-4" aria-hidden />
                {t("teams.editor.addMember")}
              </Button>
            </div>

            {team.members.length === 0 ? (
              <EmptyState
                icon={Bot}
                title={t("teams.editor.membersTitle")}
                description={t("teams.editor.membersDesc")}
                action={
                  <Button variant="primary" onClick={openCreate}>
                    <Plus className="h-4 w-4" aria-hidden />
                    {t("teams.editor.addMember")}
                  </Button>
                }
              />
            ) : (
              <StaggerGroup className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {team.members.map((member) => (
                  <MemberCard
                    key={member.id}
                    teamId={team.id}
                    member={member}
                    onEdit={openEdit}
                    onRemove={setRemoving}
                  />
                ))}
              </StaggerGroup>
            )}
          </div>
        </div>

        <div>
          <Card className="p-5">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink">
              <ShieldCheck className="h-4 w-4 text-accent" aria-hidden />
              {t("teams.editor.validationTitle")}
            </h2>
            {issues.length === 0 ? (
              <div className="flex items-center gap-2.5 text-sm text-ok">
                <ShieldCheck className="h-4 w-4" aria-hidden />
                {t("teams.validation.ok")}
              </div>
            ) : (
              <ul className="space-y-2.5">
                {issues.map((issue) => {
                  const style = issueStyles[issue.level];
                  const Icon = style.icon;
                  return (
                    <li
                      key={issue.id}
                      className="flex items-start gap-2.5 rounded-xl border border-line bg-card-hover px-3 py-2.5"
                    >
                      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.color}`} aria-hidden />
                      <span className="text-[13px] leading-snug text-ink-2">
                        {t(issue.textKey as MessageKey, issue.values)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <MemberEditorDialog open={editorOpen} onOpenChange={setEditorOpen} member={editing} onSave={handleSave} />

      <Dialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={t("teams.editor.removeTitle")}
        description={removing ? t("teams.editor.removeDesc", { name: removing.displayName }) : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(undefined)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={handleRemove}>
              <Trash2 className="h-4 w-4" aria-hidden />
              {t("teams.editor.remove")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-3">{removing?.role.name}</p>
      </Dialog>

      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("teams.editor.deleteTitle")}
        description={t("teams.editor.deleteDesc", { name: team.name })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={handleDelete}>
              <Trash2 className="h-4 w-4" aria-hidden />
              {t("teams.editor.deleteTeam")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-3">{t("teams.card.members", { count: team.members.length })}</p>
      </Dialog>
    </>
  );
}
