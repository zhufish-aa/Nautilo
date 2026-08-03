import { useNavigate } from "react-router-dom";
import { Plus, Users } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { formatRelativeTime } from "../../lib/utils";
import { providerMeta } from "../../lib/provider-catalog";
import type { UiTeam } from "../../lib/types";
import { PageHeader } from "../../components/layout/AppShell";
import { MotionCard, StaggerGroup } from "../../components/ui/Card";
import { StatusChip, Tag } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { useTeamsStore } from "../../stores/teams";
import { useAgentsStore } from "../../stores/agents";

function TeamCard({ team }: { team: UiTeam }): JSX.Element {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const instances = useAgentsStore((state) => state.instances);

  return (
    <MotionCard
      interactive
      onClick={() => navigate(`/teams/${team.id}`)}
      role="link"
      tabIndex={0}
      aria-label={team.name}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          navigate(`/teams/${team.id}`);
        }
      }}
      className="flex flex-col gap-4 p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent-soft text-accent"
          >
            <Users className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold text-ink">{team.name}</h3>
            <p className="text-xs text-ink-3">{t("teams.card.members", { count: team.members.length })}</p>
          </div>
        </div>
        <StatusChip tone="accent" label={t(`teams.policy.${team.delegationPolicy}` as MessageKey)} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {team.members.slice(0, 5).map((member) => {
          const instance = instances.find((item) => item.id === member.agentInstanceId);
          const meta = instance ? providerMeta(instance.providerId) : undefined;
          return (
            <Tag
              key={member.id}
              label={`${member.displayName}${meta ? ` · ${meta.name}` : ""}${member.enabled ? "" : " ⃠"}`}
            />
          );
        })}
        {team.members.length > 5 && <Tag label={`+${team.members.length - 5}`} />}
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-line pt-3 text-xs text-ink-3">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Users className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
          <span className="truncate">{t("teams.card.delegatePool")}</span>
        </span>
        <span className="shrink-0">{t("teams.card.updatedAt", { time: formatRelativeTime(team.updatedAt, locale) })}</span>
      </div>
    </MotionCard>
  );
}

export function TeamsPage(): JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const teams = useTeamsStore((state) => state.teams);
  const createTeam = useTeamsStore((state) => state.createTeam);

  const handleCreate = async (): Promise<void> => {
    const team = await createTeam(t("teams.card.untitled"));
    navigate(`/teams/${team.id}`);
  };

  return (
    <div data-tour="teams-page">
      <PageHeader
        title={t("teams.title")}
        subtitle={t("teams.subtitle")}
        actions={
          <>
            <StatusChip tone="muted" label={t("teams.count", { count: teams.length })} />
            <Button variant="primary" onClick={() => void handleCreate()}>
              <Plus className="h-4 w-4" aria-hidden />
              {t("teams.new")}
            </Button>
          </>
        }
      />

      {teams.length === 0 ? (
        <EmptyState
          icon={Users}
          title={t("teams.empty.title")}
          description={t("teams.empty.desc")}
          action={
            <Button variant="primary" onClick={() => void handleCreate()}>
              <Plus className="h-4 w-4" aria-hidden />
              {t("teams.empty.action")}
            </Button>
          }
        />
      ) : (
        <StaggerGroup className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {teams.map((team) => (
            <TeamCard key={team.id} team={team} />
          ))}
        </StaggerGroup>
      )}
    </div>
  );
}
