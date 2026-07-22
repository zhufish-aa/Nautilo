import { useMemo, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Input";
import { SelectField, type SelectOption } from "../../components/ui/Select";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useTeamsStore } from "../../stores/teams";
import { useAgentsStore } from "../../stores/agents";

const NO_TEAM = "no-team";

export function NewSessionDialog({
  open,
  onOpenChange,
  onCreated
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (sessionId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const teams = useTeamsStore((state) => state.teams);
  const instances = useAgentsStore((state) => state.instances);
  const createSession = useSessionsStore((state) => state.createSession);
  const [projectId, setProjectId] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [teamId, setTeamId] = useState(NO_TEAM);
  const [title, setTitle] = useState("");

  const projectOptions = useMemo<SelectOption[]>(
    () => projects.map((project) => ({ value: project.id, label: project.name, hint: project.rootPath })),
    [projects]
  );
  const instanceOptions = useMemo<SelectOption[]>(
    () => instances.map((instance) => ({
      value: instance.id,
      label: instance.displayName,
      hint: instance.providerId,
      disabled: !instance.enabled
    })),
    [instances]
  );
  const teamOptions = useMemo<SelectOption[]>(
    () => [
      { value: NO_TEAM, label: t("sessions.noDelegateTeam"), hint: t("sessions.noDelegateTeamHint") },
      ...teams.map((team) => ({
        value: team.id,
        label: team.name,
        hint: t("teams.card.members", { count: team.members.filter((member) => member.enabled).length })
      }))
    ],
    [teams, t]
  );
  const selectedInstance = instances.find((instance) => instance.id === instanceId);
  const canCreate = !!projectId && !!selectedInstance;

  const reset = (): void => {
    setProjectId("");
    setInstanceId("");
    setTeamId(NO_TEAM);
    setTitle("");
  };
  const submit = (): void => {
    if (!canCreate || !selectedInstance) return;
    const session = createSession({
      projectId,
      target: { type: "agent", instanceId, teamId: teamId === NO_TEAM ? undefined : teamId },
      title: title.trim() || selectedInstance.displayName
    });
    onCreated(session.id);
    onOpenChange(false);
    reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      title={t("sessions.newTitle")}
      description={t("sessions.newDesc")}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={submit} disabled={!canCreate}>{t("common.create")}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t("sessions.projectLabel")}>
          <SelectField aria-label={t("sessions.projectLabel")} value={projectId || undefined} onValueChange={setProjectId} options={projectOptions} placeholder={t("sessions.projectLabel")} />
        </Field>
        <Field label={t("sessions.cliLabel")}>
          <SelectField aria-label={t("sessions.cliLabel")} value={instanceId || undefined} onValueChange={setInstanceId} options={instanceOptions} placeholder={t("sessions.cliPlaceholder")} />
        </Field>
        <Field label={t("sessions.delegateTeamLabel")} hint={t("sessions.delegateTeamHint")}>
          <SelectField aria-label={t("sessions.delegateTeamLabel")} value={teamId} onValueChange={setTeamId} options={teamOptions} />
        </Field>
        <Field label={`${t("sessions.titleLabel")} (${t("common.optional")})`} htmlFor="session-title">
          <Input id="session-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("sessions.titlePlaceholder")} />
        </Field>
      </div>
    </Dialog>
  );
}
