import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, Crown, Settings2 } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { providerMeta } from "../../lib/provider-catalog";
import type { UiSession, UiTeam, UiTeamMember } from "../../lib/types";
import { StatusChip, Tag } from "../../components/ui/Badge";
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

  return (
    <li>
      <button
        onClick={() => onOpen(session.id)}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all duration-150 outline-none",
          "focus-visible:ring-2 focus-visible:ring-accent/70",
          active ? "border-accent/40 bg-accent-soft/70" : "border-line bg-card hover:border-accent/30 hover:bg-card-hover"
        )}
      >
        <span
          aria-hidden
          className="relative mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-gradient-to-br from-violet-500/25 to-fuchsia-500/15 text-violet-400"
        >
          <Bot className="h-4 w-4" />
          <span
            className={cn(
              "absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full border border-card",
              status === "running" ? "bg-accent motion-safe:animate-pulse" : status === "completed" ? "bg-ok" : status === "failed" ? "bg-danger" : "bg-ink-3"
            )}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cn("truncate text-[13px] font-medium", active ? "text-accent" : "text-ink")}>
              {member?.displayName ?? session.title}
            </span>
            {isMain && <Crown className="h-3.5 w-3.5 shrink-0 text-warn" aria-label={t("sessions.panel.mainBadge")} />}
            {session.unreadCount > 0 && (
              <span className="ml-auto flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-on-accent">
                {session.unreadCount}
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-ink-3">
            {[member?.role.name, providerName, model].filter(Boolean).join(" · ")}
          </span>
          {!isMain && (
            <span className="mt-1 block truncate text-[11px] text-ink-3" title={session.title}>
              {session.title}
            </span>
          )}
        </span>
        <StatusChip
          tone={tone}
          label={t(`sessions.status.${status}` as MessageKey)}
          pulse={status === "running"}
          className="h-5 shrink-0 px-1.5 text-[10px]"
        />
      </button>
    </li>
  );
}

export function AgentPanel({
  session,
  onOpenSession
}: {
  session?: UiSession;
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  // Guard outside the hook-bearing body: hooks must not run without a session.
  if (!session) {
    return <aside className="hidden w-64 shrink-0 border-l border-line bg-panel backdrop-blur-xl xl:block" />;
  }
  return <AgentPanelBody session={session} onOpenSession={onOpenSession} />;
}

function AgentPanelBody({
  session,
  onOpenSession
}: {
  session: UiSession;
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
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

  return (
    <aside aria-label={t("sessions.panel.title")} className="hidden w-64 shrink-0 flex-col border-l border-line bg-panel backdrop-blur-xl xl:flex">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-xs font-semibold tracking-widest text-ink-3 uppercase">{t("sessions.panel.title")}</h2>
        {team && (
          <button
            onClick={() => navigate(`/teams/${team.id}`)}
            title={t("sessions.panel.editTeam")}
            className="rounded-md p-1 text-ink-3 transition-colors hover:bg-accent-soft hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
          >
            <Settings2 className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {team && root ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between px-1">
              <span className="truncate text-xs text-ink-3">{team.name}</span>
              <Tag label={t(`teams.policy.${team.delegationPolicy}` as MessageKey)} className="shrink-0" />
            </div>

            <section>
              <h3 className="mb-1.5 px-1 text-[11px] font-semibold tracking-widest text-ink-3 uppercase">
                {t("sessions.panel.mainSession")}
              </h3>
              <ul className="space-y-2">
                <SessionEntryRow info={rootInfo} isMain active={session.id === root.id} onOpen={onOpenSession} />
              </ul>
            </section>

            <section>
              <h3 className="mb-1.5 px-1 text-[11px] font-semibold tracking-widest text-ink-3 uppercase">
                {t("sessions.panel.subSessions")}
              </h3>
              {subs.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line-strong px-3 py-3 text-center text-xs text-ink-3">
                  {t("sessions.panel.noSub")}
                </p>
              ) : (
                <ul className="space-y-2">
                  {subs.map((sub) => (
                    <SubEntry key={sub.id} session={sub} team={team} active={session.id === sub.id} onOpen={onOpenSession} />
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : (
          <SingleAgentInfo session={session} />
        )}
      </div>
    </aside>
  );
}

function SubEntry({
  session,
  team,
  active,
  onOpen
}: {
  session: UiSession;
  team: UiTeam;
  active: boolean;
  onOpen: (id: string) => void;
}): JSX.Element {
  const info = useEntryInfo(session, team);
  return <SessionEntryRow info={info} isMain={false} active={active} onOpen={onOpen} />;
}

function SingleAgentInfo({ session }: { session: UiSession }): JSX.Element {
  const { t } = useI18n();
  const instances = useAgentsStore((state) => state.instances);
  const target = session.target;
  const instance =
    target.type === "agent" ? instances.find((item) => item.id === target.instanceId) : undefined;
  const meta = instance ? providerMeta(instance.providerId) : undefined;

  return (
    <div className="space-y-3">
      <p className="px-1 text-xs text-ink-3">{t("sessions.panel.single")}</p>
      <div className="rounded-xl border border-line bg-card p-4">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-lg border border-accent/20 bg-accent-soft text-accent">
            <Bot className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-ink">{instance?.displayName ?? "Agent"}</p>
            <p className="truncate text-[11px] text-ink-3">{meta?.name}</p>
          </div>
        </div>
        <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-xs">
          <div className="flex justify-between gap-2">
            <dt className="text-ink-3">{t("agents.instances.model")}</dt>
            <dd className="font-mono text-ink-2">{session.model ?? t("agents.instances.defaultModel")}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-ink-3">{t("agents.editor.basic.reasoning")}</dt>
            <dd className="font-mono text-ink-2">{session.reasoningEffort ?? t("agents.editor.basic.reasoningDefault")}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
