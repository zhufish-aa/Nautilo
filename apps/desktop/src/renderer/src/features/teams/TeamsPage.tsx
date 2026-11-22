import { useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Loader2, Plus, Search, Users } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input } from "../../components/ui/Input";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { useAgentsStore } from "../../stores/agents";
import { useConnectionsStore } from "../../stores/connections";
import { useTeamsStore, validateTeam } from "../../stores/teams";
import { TeamWorkbench } from "./TeamEditorPage";
import "./team-workbench.css";

export function TeamsPage({ embedded = false }: { embedded?: boolean }): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const location = useLocation();
  const navigate = useNavigate();
  const { teamId } = useParams();
  const [params] = useSearchParams();
  const teams = useTeamsStore(state => state.teams);
  const instances = useAgentsStore(state => state.instances);
  const connections = useConnectionsStore(state => state.connections);
  const createTeam = useTeamsStore(state => state.createTeam);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  const entries = useMemo(() => teams.map(team => ({
    team,
    issues: validateTeam(team, instances, connections).filter(issue => !issue.id.startsWith("member-disabled-")),
    enabled: team.members.filter(member => member.enabled).length,
  })), [teams, instances, connections]);
  const requested = params.get("team") || teamId;
  const selected = entries.find(entry => entry.team.id === requested) ?? entries[0];
  const visible = entries.filter(({ team }) => team.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selectTeam = (id?: string): void => {
    const next = new URLSearchParams(params);
    if (id) next.set("team", id);
    else next.delete("team");
    navigate({ pathname: embedded ? location.pathname : "/teams", search: next.toString() }, {
      replace: true, state: location.state, preventScrollReset: true,
    });
  };

  const startCreate = (): void => {
    setName("");
    setError("");
    setOpen(true);
  };
  const handleCreate = async (): Promise<void> => {
    if (inFlight.current || pending) return;
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
      setQuery("");
      selectTeam(team.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <section data-tour="teams-page" className="teams-page">
      <header className="team-page-heading">
        <div>
          <h1>{zh ? "团队管理" : "Team management"}</h1>
          <span>{zh ? `${teams.length} 个团队` : t("teams.count", { count: teams.length })}</span>
        </div>
        <Button type="button" variant="primary" size="sm" disabled={pending} onClick={startCreate}>
          <Plus size={15} aria-hidden />{t("teams.new")}
        </Button>
      </header>
      <div className="team-workspace">
        <aside className="team-sidebar" aria-label={zh ? "团队列表" : "Teams"}>
          <div className="team-search">
            <Search size={14} aria-hidden />
            <input id="team-search" type="search" value={query} onChange={event => setQuery(event.target.value)}
              placeholder={zh ? "搜索团队" : "Search teams"} aria-label={zh ? "搜索团队" : "Search teams"} />
          </div>
          <ul className="team-sidebar-list">
            {visible.map(({ team, issues, enabled }) => (
              <li key={team.id}>
                <button type="button" className="team-sidebar-item" aria-pressed={team.id === selected?.team.id}
                  disabled={pending} onClick={() => selectTeam(team.id)}>
                  <span className="team-sidebar-title">
                    <strong title={team.name}>{team.name}</strong>
                    <span title={zh ? "已启用 / 全部成员" : "Enabled / all members"}>{enabled}/{team.members.length}</span>
                  </span>
                  <span className="team-sidebar-meta">
                    <span className="team-state-dot" data-tone={issues[0]?.level ?? "ok"}
                      title={issues.length ? (zh ? "配置待修正" : "Needs attention") : (zh ? "就绪" : "Ready")} />
                    <span className="team-policy-label">{t(`teams.policy.${team.delegationPolicy}` as MessageKey)}</span>
                    <span className="team-sidebar-marks" aria-hidden>
                      {team.members.flatMap(member => {
                        const instance = instances.find(candidate => candidate.id === member.agentInstanceId);
                        return instance ? [{ id: member.id, providerId: instance.providerId }] : [];
                      }).slice(0, 3).map(({ id, providerId }) => <ProviderAvatar key={id} providerId={providerId} size="sm" />)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {teams.length > 0 && visible.length === 0 && <p className="team-search-empty">{zh ? "未找到匹配的团队" : "No matching teams"}</p>}
        </aside>
        {selected ? (
          <TeamWorkbench key={selected.team.id} team={selected.team} issues={selected.issues}
            pending={pending} setPending={setPending} onDelete={() => selectTeam()} />
        ) : (
          <div className="team-workspace-empty">
            <EmptyState icon={Users} title={requested ? (zh ? "团队不存在" : "Team not found") : t("teams.empty.title")}
              description={t("teams.empty.desc")}
              action={<Button type="button" variant="outline" size="sm" disabled={pending} onClick={startCreate}>
                <Plus size={15} aria-hidden />{t("teams.empty.action")}
              </Button>} />
          </div>
        )}
      </div>
      <Dialog open={open} onOpenChange={value => { if (!pending) setOpen(value); }} title={t("teams.new")}
        widthClass="max-w-md team-dialog" footer={<>
          <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={pending || !name.trim()} onClick={() => void handleCreate()}>
            {pending && <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden />}{zh ? "创建" : "Create"}
          </Button>
        </>}>
        <Field label={t("teams.editor.nameLabel")} htmlFor="new-team-name" error={error}>
          <Input id="new-team-name" value={name} autoFocus disabled={pending} aria-invalid={Boolean(error)}
            onChange={event => setName(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void handleCreate(); } }}
            placeholder={t("teams.editor.namePlaceholder")} />
        </Field>
      </Dialog>
    </section>
  );
}
