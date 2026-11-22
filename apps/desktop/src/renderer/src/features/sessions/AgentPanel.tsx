import { useMemo } from "react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { providerMeta } from "../../lib/provider-catalog";
import type { UiSession, UiTeam, UiTeamMember } from "../../lib/types";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { useSessionsStore } from "../../stores/sessions";
import { useTeamsStore } from "../../stores/teams";
import { useAgentsStore } from "../../stores/agents";
import { visibleSessionStatus } from "../../lib/session-lifecycle";

/**
 * Right rail (per the workbench contract): the current run's sessions —
 * the main session plus one sub-agent session per actual delegation.
 * Clicking an entry switches the central chat to that session (F-044);
 * no sub-session exists unless the main agent actually delegated (F-025/F-026).
 */

interface SessionEntryInfo {
  session: UiSession;
  member?: UiTeamMember;
  providerName?: string;
  providerId?: string;
  model?: string;
}

function useEntryInfo(entry: UiSession, team?: UiTeam): SessionEntryInfo {
  const instances = useAgentsStore((state) => state.instances);
  return useMemo(() => {
    const target = entry.target;
    let member: UiTeamMember | undefined;
    if (team) {
      if (target.type === "member") {
        member = team.members.find((item) => item.id === target.memberId);
      }
    }
    const instanceId = member?.agentInstanceId ?? (target.type === "agent" ? target.instanceId : undefined);
    const instance = instances.find((item) => item.id === instanceId);
    return {
      session: entry,
      member,
      providerName: instance ? providerMeta(instance.providerId).name : undefined,
      providerId: instance?.providerId,
      model: entry.model ?? member?.model
    };
  }, [entry, team, instances]);
}

function SessionEntryRow({
  info,
  isMain,
  active,
  onOpen
}: {
  info: SessionEntryInfo;
  isMain: boolean;
  active: boolean;
  onOpen: (id: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const { session, member, providerName, model } = info;
  const orchestrationLifecycle = useSessionsStore((state) => state.running[session.id]);
  const status = visibleSessionStatus(session.status, orchestrationLifecycle);
  const tone =
    status === "running"
      ? "accent"
      : status === "waiting_approval"
        ? "warn"
        : status === "failed"
          ? "danger"
          : status === "completed"
            ? "ok"
            : "muted";

  const title = session.title || member?.displayName || t("sessions.header.untitled");
  return <li>
    <button type="button" className="session-inspector-agent" aria-current={active ? "page" : undefined}
      onClick={() => onOpen(session.id)} title={[title, member?.role.name, providerName, model].filter(Boolean).join(" · ")}>
      <span className="session-inspector-harness" data-status={status}>
        <ProviderAvatar providerId={info.providerId ?? "custom"} size="sm" />
      </span>
      <span className="session-inspector-agent-name">{title}</span>
      {isMain && <span className="sr-only">{t("sessions.panel.mainSession")}</span>}
      {session.unreadCount > 0 && <span className="session-inspector-unread">{session.unreadCount}</span>}
      <span className="session-inspector-status" data-tone={tone}>{t(`sessions.status.${status}` as MessageKey)}</span>
    </button>
  </li>;
}

export function AgentPanel({
  session,
  onOpenSession
}: {
  session: UiSession;
  onOpenSession: (sessionId: string) => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const teams = useTeamsStore((state) => state.teams);
  const allSessions = useSessionsStore((state) => state.sessions);

  const target = session.target;
  const team =
    target.type === "team"
      ? teams.find((item) => item.id === target.teamId)
      : target.type === "member"
        ? teams.find((item) => item.id === target.teamId)
        : target.teamId
          ? teams.find((item) => item.id === target.teamId)
          : undefined;

  // The run group: root (main) session + sub-agent sessions of the same run.
  const { root, subs } = useMemo(() => {
    const rootId = session.parentSessionId ?? session.id;
    const rootSession = allSessions.find((item) => item.id === rootId) ?? session;
    const children = allSessions
      .filter((item) => item.parentSessionId === rootSession.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { root: rootSession, subs: children };
  }, [session, allSessions]);

  const rootInfo = useEntryInfo(root, team);
  if (subs.length === 0 && root.id === session.id) return null;

  return <section className="session-inspector-section session-inspector-lineage">
    <header className="session-inspector-section-heading"><h3>{t("sessions.panel.subSessions")}</h3></header>
    <ul>
      {session.id !== root.id && <SessionEntryRow info={rootInfo} isMain active={false} onOpen={onOpenSession} />}
      {subs.map(sub => <SubEntry key={sub.id} session={sub} team={team} active={session.id === sub.id} onOpen={onOpenSession} />)}
    </ul>
  </section>;
}

function SubEntry({ session, team, active, onOpen }: {
  session: UiSession;
  team?: UiTeam;
  active: boolean;
  onOpen: (id: string) => void;
}): JSX.Element {
  const info = useEntryInfo(session, team);
  return <SessionEntryRow info={info} isMain={false} active={active} onOpen={onOpen} />;
}
