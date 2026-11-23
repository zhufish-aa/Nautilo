import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { useProviderMetas } from "../../lib/provider-catalog";
import { isActiveLifecycle, visibleSessionStatus } from "../../lib/session-lifecycle";
import { formatDurationMs } from "../../lib/subagent-result";
import type { TimelineEvent, UiSession } from "../../lib/types";
import { useSessionsStore } from "../../stores/sessions";
import { useTeamsStore } from "../../stores/teams";
import { useAgentsStore } from "../../stores/agents";
import { useConnectionsStore } from "../../stores/connections";
import { InspectorDisclosure } from "./InspectorDisclosure";

type EntryStatus = UiSession["status"] | "cancelled";

function completionTime(events?: TimelineEvent[]): string | undefined {
  let end: TimelineEvent | undefined;
  for (const event of events ?? []) {
    if (event.runId && event.data.kind === "activity" && event.data.phase === "completed" && event.data.detail !== "turn_failed") end = event;
  }
  if (!end) return;
  const { runId, sequence, timestamp } = end;
  const start = events?.find(event => event.runId === runId && event.sequence < sequence
    && event.data.kind === "activity" && event.data.phase === "starting");
  if (!start) return;
  const elapsed = Date.parse(timestamp) - Date.parse(start.timestamp);
  if (Number.isFinite(elapsed) && elapsed >= 0) return formatDurationMs(elapsed).replace(/\.0s$/, "s");
}

export function AgentPanel({ session, onOpenSession, showEmpty }: {
  session: UiSession;
  onOpenSession: (id: string) => void;
  showEmpty?: boolean;
}): JSX.Element | null {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const teams = useTeamsStore(state => state.teams);
  const instances = useAgentsStore(state => state.instances);
  const connections = useConnectionsStore(state => state.connections);
  const harnesses = useProviderMetas();
  const sessions = useSessionsStore(state => state.sessions);
  const running = useSessionsStore(state => state.running);
  const foreground = useSessionsStore(state => state.foreground);
  const rootId = session.parentSessionId ?? session.id;
  const root = sessions.find(item => item.id === rootId) ?? session;

  const children = useMemo(() => {
    const lineage = sessions.filter(item => item.parentSessionId === rootId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return lineage.map(item => {
      const target = item.target;
      const member = target.type === "member" ? teams.find(team => team.id === target.teamId)?.members.find(candidate => candidate.id === target.memberId) : undefined;
      const explicitTitle = item.title === "Agent" ? undefined : item.title;
      const title = explicitTitle || member?.displayName || item.title || t("sessions.header.untitled");
      const turn = foreground[item.id];
      const run = isActiveLifecycle(turn) ? turn : running[item.id] ?? turn;
      const status: EntryStatus = run?.status === "cancelled" ? "cancelled" : visibleSessionStatus(item.status, run);
      return { item, title, status, instanceId: target.type === "agent" ? target.instanceId : member?.agentInstanceId,
        model: item.model || member?.model };
    }).sort((a, b) => Number(b.status === "running") - Number(a.status === "running")
      || (b.item.lastMessageAt ?? b.item.updatedAt).localeCompare(a.item.lastMessageAt ?? a.item.updatedAt));
  }, [sessions, rootId, teams, running, foreground, t]);
  const history = useSessionsStore(useShallow(state => Object.fromEntries(children.filter(entry => entry.status === "completed")
    .map(({ item }) => [item.id, state.events[item.id]]))));

  if (!children.length && root.id === session.id && !showEmpty) return null;
  const active = children.filter(entry => entry.status === "running").length;
  function row({ item, title, status, instanceId, model }: typeof children[number]): JSX.Element {
    const instance = instances.find(candidate => candidate.id === instanceId);
    const connection = !instance ? connections.find(candidate => candidate.id === item.connectionId
      && (item.connectionRevision === undefined || candidate.revision === item.connectionRevision)) : undefined;
    const harnessId = instance?.providerId ?? connection?.harness;
    const harnessName = harnessId && (harnesses.find(harness => harness.id === harnessId)?.name ?? harnessId);
    const statusText = status === "completed" ? (completionTime(history[item.id]) ?? t("sessions.status.completed"))
      : status === "cancelled" ? (zh ? "已中断" : "Interrupted") : t(`sessions.status.${status}` as MessageKey);
    return <li key={item.id}>
      <button type="button" className="session-inspector-agent" aria-current={session.id === item.id ? "page" : undefined}
        onClick={() => onOpenSession(item.id)} title={title}>
        <span className="session-inspector-agent-harness" title={[harnessName, model].filter(Boolean).join(" · ")} aria-hidden>
          <ProviderAvatar providerId={harnessId ?? "custom"} size="sm" />
          <span className="session-inspector-dot" data-status={status} />
        </span>
        <span className="session-inspector-agent-name">{title}</span>
        {item.unreadCount > 0 && <span className="session-inspector-unread">{item.unreadCount}</span>}
        <span className="session-inspector-status" data-status={status}>{statusText}</span>
      </button>
    </li>;
  }
  return <InspectorDisclosure className="session-inspector-lineage" label={t("sessions.panel.subSessions")}
    summary={<span className="session-inspector-section-meta">{active > 0 && <b>{zh ? `${active} 运行中` : `${active} running`} · </b>}{children.length}</span>}>
    <ul>
      {session.id !== root.id && row({ item: root, title: root.title || t("sessions.panel.mainSession"), status: visibleSessionStatus(root.status, running[root.id]),
        instanceId: root.target.type === "agent" ? root.target.instanceId : undefined, model: root.model })}
      {children.slice(0, 4).map(row)}
    </ul>
    {!children.length && showEmpty && <p className="session-inspector-muted">{zh ? "暂无子 Agent 会话" : "No sub-agent conversations"}</p>}
    {children.length > 4 && <InspectorDisclosure className="session-inspector-more-agents"
      label={zh ? "收起" : "Show fewer"} closedLabel={zh ? `展开全部 (${children.length})` : `Show all (${children.length})`} defaultOpen={false} triggerAfter>
      <ul>{children.slice(4).map(row)}</ul>
    </InspectorDisclosure>}
  </InspectorDisclosure>;
}
