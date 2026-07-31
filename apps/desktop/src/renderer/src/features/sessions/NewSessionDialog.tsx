import { useMemo, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Input";
import { SelectField, type SelectOption } from "../../components/ui/Select";
import { useProviderMetas } from "../../lib/provider-catalog";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useTeamsStore } from "../../stores/teams";
import { useAgentsStore } from "../../stores/agents";

const NO_TEAM = "no-team";

export function NewSessionDialog({
  open,
  onOpenChange,
  onCreated,
  mode
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (sessionId: string) => void;
  /** Stamp the new session as a Work (office deliverables) conversation. */
  mode?: "code" | "work";
}): JSX.Element {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const teams = useTeamsStore((state) => state.teams);
  const instances = useAgentsStore((state) => state.instances);
  const providers = useProviderMetas();
  const createSession = useSessionsStore((state) => state.createSession);
  const [projectId, setProjectId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [teamId, setTeamId] = useState(NO_TEAM);
  const [title, setTitle] = useState("");

  const projectOptions = useMemo<SelectOption[]>(
    () => projects.map((project) => ({ value: project.id, label: project.name, hint: project.rootPath })),
    [projects]
  );
  const providerOptions = useMemo<SelectOption[]>(
    () => providers.map((provider) => {
      const count = instances.filter((instance) => instance.providerId === provider.id && instance.enabled).length;
      return {
        value: provider.id,
        label: provider.name,
        hint: count > 0 ? t("sessions.providerInstanceCount", { count }) : t("sessions.noProviderInstance"),
        disabled: count === 0
      };
    }),
    [providers, instances, t]
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
  // The session still binds to one agent instance underneath; the provider
  // picker just chooses which family, defaulting to its first enabled instance.
  // The instance (API source) can be switched later inside the session.
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const defaultInstance = instances.find((instance) => instance.providerId === providerId && instance.enabled);
  const canCreate = !!projectId && !!selectedProvider && !!defaultInstance;

  const reset = (): void => {
    setProjectId("");
    setProviderId("");
    setTeamId(NO_TEAM);
    setTitle("");
  };
  const submit = (): void => {
    if (!canCreate || !selectedProvider || !defaultInstance) return;
    const session = createSession({
      projectId,
      target: { type: "agent", instanceId: defaultInstance.id, teamId: teamId === NO_TEAM ? undefined : teamId },
      title: title.trim() || selectedProvider.name,
      mode
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
          <SelectField aria-label={t("sessions.cliLabel")} value={providerId || undefined} onValueChange={setProviderId} options={providerOptions} placeholder={t("sessions.cliPlaceholder")} />
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
