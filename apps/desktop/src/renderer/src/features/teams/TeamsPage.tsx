import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronRight, Loader2, Plus, Users } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input } from "../../components/ui/Input";
import { useTeamsStore } from "../../stores/teams";
import { IdentityAvatar, ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { useAgentsStore } from "../../stores/agents";
import { providerMeta } from "../../lib/provider-catalog";

export function TeamsPage({ embedded = false }: { embedded?: boolean }): JSX.Element {
  const teamUrl = (id: string): string => embedded ? `/settings?section=teams&team=${encodeURIComponent(id)}` : `/teams/${encodeURIComponent(id)}`;
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const navigate = useNavigate();
  const teams = useTeamsStore((state) => state.teams);
  const instances = useAgentsStore((state) => state.instances);
  const createTeam = useTeamsStore((state) => state.createTeam);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const startCreate = (): void => {
    setName("");
    setError("");
    setOpen(true);
  };
  const handleCreate = async (): Promise<void> => {
    if (inFlight.current) return;
    if (!name.trim()) {
      setError(t("agents.editor.nameRequired"));
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const team = await createTeam(name.trim());
      setOpen(false);
      navigate(teamUrl(team.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <div data-tour="teams-page" className="teams-page">
      <header className="teams-page-header">
        <div>
          <h2>{t("teams.title")}</h2>
        </div>
          <Button variant="primary" onClick={startCreate}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("teams.new")}
          </Button>
      </header>
      {teams.length === 0 ? (
        <EmptyState
          icon={Users}
          title={t("teams.empty.title")}
          description={t("teams.empty.desc")}
          action={
            <Button variant="primary" onClick={startCreate}>
              <Plus className="h-4 w-4" aria-hidden />
              {t("teams.empty.action")}
            </Button>
          }
        />
      ) : (
        <ul className="team-list team-overview-list" data-single={teams.length === 1}>
          {teams.map((team) => (
            <li key={team.id}>
              <Link
                to={teamUrl(team.id)}
                className="team-overview-card"
              >
                <div className="team-overview-card-heading"><IdentityAvatar label={team.name} seed={team.id} /><strong>{team.name}</strong><span className="team-overview-policy">{t(`teams.policy.${team.delegationPolicy}` as MessageKey)}</span></div>
                <div className="team-preview-members">{team.members.slice(0, 4).map((member) => {
                  const instance = instances.find((item) => item.id === member.agentInstanceId);
                  const meta = instance ? providerMeta(instance.providerId) : undefined;
                  return <div className="team-preview-member" data-enabled={member.enabled} key={member.id}><ProviderAvatar providerId={instance?.providerId ?? "custom"} size="sm" /><div><strong>{member.displayName}</strong><span>{member.role.name}</span><p title={member.model}>{meta?.name ?? "—"} · {member.model || (zh ? "默认模型" : "Default model")}</p></div></div>;
                })}</div>
                <div className="team-overview-card-footer"><span><Users size={14} aria-hidden />{t("teams.card.members", { count: team.members.length })}</span><span>{zh ? "配置团队" : "Configure team"}<ChevronRight size={15} aria-hidden /></span></div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!pending) setOpen(value);
        }}
        title={t("teams.new")}
        footer={
          <>
            <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={pending || !name.trim()}
              onClick={() => void handleCreate()}
            >
              {pending && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />}
              {zh ? "创建" : "Create"}
            </Button>
          </>
        }
      >
        <Field label={t("teams.editor.nameLabel")} htmlFor="new-team-name" error={error}>
          <Input
            id="new-team-name"
            value={name}
            autoFocus
            disabled={pending}
            aria-invalid={Boolean(error)}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleCreate();
              }
            }}
            placeholder={t("teams.editor.namePlaceholder")}
          />
        </Field>
      </Dialog>
    </div>
  );
}
