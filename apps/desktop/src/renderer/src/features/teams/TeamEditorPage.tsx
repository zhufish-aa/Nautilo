import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CircleHelp,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Users
} from "lucide-react";
import type { DelegationPolicy } from "@agenthub/domain";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { providerMeta } from "../../lib/provider-catalog";
import type { UiTeamMember } from "../../lib/types";
import { newId } from "../../lib/utils";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { Tooltip } from "../../components/ui/Tooltip";
import { useTeamsStore, validateTeam } from "../../stores/teams";
import { useAgentsStore } from "../../stores/agents";
import { toast } from "../../stores/toast";
import { MemberEditorDialog } from "./MemberEditorDialog";
import { persistTeamChange } from "./team-mutations";

const POLICIES: DelegationPolicy[] = ["autonomous", "ask_before_delegate", "direct_only"];

export function TeamEditorPage(): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
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
  const [editing, setEditing] = useState<UiTeamMember>();
  const [removing, setRemoving] = useState<UiTeamMember>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const issues = useMemo(() => (team ? validateTeam(team, instances) : []), [team, instances]);
  const instanceById = useMemo(
    () => new Map(instances.map((instance) => [instance.id, instance])),
    [instances]
  );
  if (!team)
    return (
      <EmptyState
        icon={Users}
        title={zh ? "团队不存在" : "Team not found"}
        description={t("teams.empty.desc")}
        action={
          <Button variant="outline" onClick={() => navigate("/teams")}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {t("teams.editor.back")}
          </Button>
        }
      />
    );

  const mutate = async (action: () => Promise<void>, onSuccess?: () => void): Promise<void> => {
    if (inFlight.current) return;
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
  const handleSave = async (draft: Omit<UiTeamMember, "id">): Promise<void> => {
    // Let the member dialog show the error and remain open until Core confirms.
    await persistTeamChange(team.id, () =>
      editing
        ? updateMember(team.id, editing.id, draft)
        : addMember(team.id, { ...draft, id: newId("member") })
    );
  };
  const openEditor = (member?: UiTeamMember): void => {
    setEditing(member);
    setError("");
    setEditorOpen(true);
  };
  const failure = error ? (
    <p
      role="alert"
      className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-sm text-danger"
    >
      {error}
    </p>
  ) : null;
  const cancel = (close: () => void): JSX.Element => (
    <Button variant="outline" disabled={pending} onClick={close}>
      {t("common.cancel")}
    </Button>
  );
  const spinner = pending ? (
    <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
  ) : null;
  return (
    <div className="mx-auto max-w-5xl py-3 sm:py-6">
      <Link
        to="/teams"
        className="mb-6 inline-flex items-center gap-2 rounded text-sm text-ink-3 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t("teams.editor.back")}
      </Link>
      <header className="mb-8 flex items-center gap-3">
        <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight">{team.name}</h1>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => {
            setName(team.name);
            setError("");
            setRenameOpen(true);
          }}
        >
          <Pencil className="h-4 w-4" aria-hidden />
          {t("common.edit")}
        </Button>
      </header>
      {!renameOpen && !removing && !confirmDelete && failure}
      <section className="mb-10 mt-5" aria-labelledby="team-policy-title">
        <div className="flex flex-wrap items-center gap-4">
          <h2 id="team-policy-title" className="text-sm text-ink-2">
            {t("teams.editor.policyTitle")}
          </h2>
          <div className="w-64 max-w-full">
            <SelectField
              value={team.delegationPolicy}
              disabled={pending}
              aria-label={t("teams.editor.policyTitle")}
              onValueChange={(value) =>
                void mutate(() =>
                  updateTeam(team.id, { delegationPolicy: value as DelegationPolicy })
                )
              }
              options={POLICIES.map((policy) => ({
                value: policy,
                label: t(`teams.policy.${policy}` as MessageKey)
              }))}
            />
          </div>
          <Tooltip content={t("teams.editor.policyDesc")}>
            <button
              type="button"
              className="rounded p-1 text-ink-3 focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={t("teams.editor.policyDesc")}
            >
              <CircleHelp className="h-4 w-4" aria-hidden />
            </button>
          </Tooltip>
        </div>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-3">
          {t(`teams.policy.${team.delegationPolicy}Desc` as MessageKey)}
        </p>
      </section>
      <section aria-labelledby="team-members-title">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="team-members-title" className="text-[15px] font-medium">
            {t("teams.editor.membersTitle")}{" "}
            <span className="ml-2 text-sm font-normal text-ink-3">{team.members.length}</span>
          </h2>
          <Button variant="ghost" disabled={pending} onClick={() => openEditor()}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("teams.editor.addMember")}
          </Button>
        </div>
        {!team.members.length ? (
          <EmptyState
            icon={Bot}
            title={t("teams.editor.membersTitle")}
            description={t("teams.editor.membersDesc")}
            action={
              <Button variant="outline" onClick={() => openEditor()}>
                <Plus className="h-4 w-4" aria-hidden />
                {t("teams.editor.addMember")}
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {team.members.map((member) => {
              const instance = instanceById.get(member.agentInstanceId);
              const meta = instance ? providerMeta(instance.providerId) : undefined;
              return (
                <li key={member.id} className="flex flex-wrap items-center gap-4 py-5">
                  <span
                    aria-hidden
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line-strong text-sm text-ink-2"
                  >
                    {Array.from(member.displayName)[0] || <Bot className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0 flex-1 sm:w-[26%] sm:flex-none">
                    <p className="truncate text-[15px] font-medium">{member.displayName}</p>
                    <p className="mt-1 truncate text-sm text-ink-3" title={member.role.description}>
                      {member.role.name}
                    </p>
                  </div>
                  <span
                    className="hidden min-w-0 flex-1 truncate text-sm text-ink-3 sm:block"
                    title={[member.model, member.reasoningEffort].filter(Boolean).join(" · ")}
                  >
                    {meta?.name ?? (zh ? "Agent 不可用" : "Agent unavailable")}
                  </span>
                  <span
                    className="hidden min-w-0 flex-1 truncate text-sm text-ink-3 lg:block"
                    title={member.role.responsibilities.join(" · ")}
                  >
                    {member.role.responsibilities[0] || member.role.description || "—"}
                  </span>
                  <Switch
                    disabled={pending}
                    checked={member.enabled}
                    onCheckedChange={(enabled) =>
                      void mutate(() => updateMember(team.id, member.id, { enabled }))
                    }
                    aria-label={`${member.displayName}: ${member.enabled ? t("common.enabled") : t("common.disabled")}`}
                  />
                  <Tooltip content={t("common.edit")}>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={pending}
                      aria-label={`${t("common.edit")} ${member.displayName}`}
                      onClick={() => openEditor(member)}
                    >
                      <Pencil className="h-4 w-4" aria-hidden />
                    </Button>
                  </Tooltip>
                  <Tooltip content={t("teams.editor.remove")}>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={pending}
                      aria-label={`${t("teams.editor.remove")} ${member.displayName}`}
                      onClick={() => {
                        setError("");
                        setRemoving(member);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-ink-3" aria-hidden />
                    </Button>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="mt-8" aria-labelledby="team-validation">
        <h2
          id="team-validation"
          className="mb-3 flex items-center gap-2 text-sm font-medium text-ink-2"
        >
          <ShieldCheck className="h-4 w-4" aria-hidden />
          {t("teams.editor.validationTitle")}
        </h2>
        {issues.length ? (
          <ul className="space-y-3">
            {issues.map((issue) => (
              <li
                key={issue.id}
                className="flex items-start gap-2 text-sm leading-relaxed text-ink-3"
              >
                <AlertTriangle
                  className={`mt-0.5 h-4 w-4 shrink-0 ${issue.level === "critical" ? "text-danger" : issue.level === "warning" ? "text-warn" : "text-ink-3"}`}
                  aria-hidden
                />
                {t(issue.textKey as MessageKey, issue.values)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-3">{t("teams.validation.ok")}</p>
        )}
      </section>
      <div className="mt-12 border-t border-line pt-5">
        <Button
          variant="ghost"
          className="text-danger hover:text-danger"
          disabled={pending}
          onClick={() => {
            setError("");
            setConfirmDelete(true);
          }}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
          {t("teams.editor.deleteTeam")}
        </Button>
      </div>
      <MemberEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        member={editing}
        onSave={handleSave}
      />
      <Dialog
        open={renameOpen}
        onOpenChange={(value) => {
          if (!pending) setRenameOpen(value);
        }}
        title={zh ? "编辑团队" : "Edit team"}
        footer={
          <>
            {cancel(() => setRenameOpen(false))}
            <Button
              variant="primary"
              disabled={pending || !name.trim()}
              onClick={() =>
                void mutate(
                  () => updateTeam(team.id, { name: name.trim() }),
                  () => setRenameOpen(false)
                )
              }
            >
              {spinner}
              {t("common.save")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={t("teams.editor.nameLabel")} htmlFor="team-name">
            <Input
              id="team-name"
              value={name}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </Field>
          {failure}
        </div>
      </Dialog>
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(value) => {
          if (!pending && !value) setRemoving(undefined);
        }}
        title={t("teams.editor.removeTitle")}
        description={
          removing ? t("teams.editor.removeDesc", { name: removing.displayName }) : undefined
        }
        footer={
          <>
            {cancel(() => setRemoving(undefined))}
            <Button
              variant="danger"
              disabled={pending}
              onClick={() =>
                removing &&
                void mutate(
                  () => removeMember(team.id, removing.id),
                  () => setRemoving(undefined)
                )
              }
            >
              {spinner}
              {t("teams.editor.remove")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-3">{removing?.role.name}</p>
          {failure}
        </div>
      </Dialog>
      <Dialog
        open={confirmDelete}
        onOpenChange={(value) => {
          if (!pending) setConfirmDelete(value);
        }}
        title={t("teams.editor.deleteTitle")}
        description={t("teams.editor.deleteDesc", { name: team.name })}
        footer={
          <>
            {cancel(() => setConfirmDelete(false))}
            <Button
              variant="danger"
              disabled={pending}
              onClick={() =>
                void mutate(
                  () => deleteTeam(team.id),
                  () => {
                    toast.info(t("teams.editor.deletedToast", { name: team.name }));
                    navigate("/teams");
                  }
                )
              }
            >
              {spinner}
              {t("teams.editor.deleteTeam")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-3">
            {t("teams.card.members", { count: team.members.length })}
          </p>
          {failure}
        </div>
      </Dialog>
    </div>
  );
}
