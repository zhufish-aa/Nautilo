import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Activity, ArrowUpRight, BarChart3, Check, ChevronRight, FileText, History, Inbox, Loader2, RefreshCw, Search, Square, Timer } from "lucide-react";
import { Switch } from "../../components/ui/Switch";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { useI18n } from "../../lib/i18n";
import { formatDateTime } from "../../lib/utils";
import { sessionLocation } from "../../lib/sidebar-navigation";
import { pendingCountsBySession } from "../../lib/notification-policy";
import { groupSessionsForDashboard } from "../../lib/runs-dashboard";
import { hydrateWorkbenchSessions, stopWorkbenchRun } from "../../lib/orchestration-runtime";
import type { TimelineEvent, UiSession } from "../../lib/types";
import { sessionTargetName } from "../sessions/SessionListPanel";
import { useAgentsStore } from "../../stores/agents";
import { useInteractionsStore } from "../../stores/interactions";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useTeamsStore } from "../../stores/teams";
import { toast } from "../../stores/toast";
import "./runs-cockpit.css";

function lastSnippet(events: TimelineEvent[] | undefined): string {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const data = events![index]!.data;
    if (data.kind === "message" && data.text.trim()) return data.text.replace(/\s+/g, " ").trim();
    if (data.kind === "tool_activity") return data.toolName;
    if (data.kind === "tool_group") { const snippet = lastSnippet(data.items); if (snippet) return snippet; }
  }
  return "";
}

export function RunsPage(): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const navigate = useNavigate();
  const sessions = useSessionsStore(state => state.sessions);
  const foreground = useSessionsStore(state => state.foreground);
  const running = useSessionsStore(state => state.running);
  const events = useSessionsStore(state => state.events);
  const bySession = useInteractionsStore(state => state.bySession);
  const setActiveSession = useSessionsStore(state => state.setActiveSession);
  const markSessionsRead = useSessionsStore(state => state.markSessionsRead);
  const teams = useTeamsStore(state => state.teams);
  const instances = useAgentsStore(state => state.instances);
  const projects = useProjectsStore(state => state.projects);
  const notificationsEnabled = useSettingsStore(state => state.notificationsEnabled);
  const notificationSound = useSettingsStore(state => state.notificationSound);
  const setNotificationSound = useSettingsStore(state => state.setNotificationSound);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [stopping, setStopping] = useState<string>();
  const [clock, setClock] = useState(Date.now());
  const [historyPage, setHistoryPage] = useState(0);
  useEffect(() => setHistoryPage(0), [filter, query]);
  const pending = useMemo(() => pendingCountsBySession(bySession), [bySession]);
  const groups = useMemo(() => groupSessionsForDashboard({ sessions, foreground, running, pending }), [sessions, foreground, running, pending]);
  const projectNames = useMemo(() => new Map(projects.map(project => [project.id, project.name])), [projects]);
  useEffect(() => { if (!groups.running.length) return; const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(timer); }, [groups.running.length]);
  const open = (session: UiSession): void => { setActiveSession(session.id); navigate(sessionLocation(session)); };
  const provider = (session: UiSession): string => {
    const target = session.target;
    const id = target.type === "agent" ? target.instanceId : target.type === "member" ? teams.find(team => team.id === target.teamId)?.members.find(member => member.id === target.memberId)?.agentInstanceId : undefined;
    return instances.find(instance => instance.id === id)?.providerId ?? "";
  };
  const meta = (session: UiSession): string => [projectNames.get(session.projectId), sessionTargetName(session, teams, instances)].filter(Boolean).join(" · ");
  const matches = (session: UiSession): boolean => `${session.title} ${meta(session)}`.toLowerCase().includes(query.trim().toLowerCase());
  const completed = sessions.filter(session => ["completed", "failed", "cancelled"].includes(foreground[session.id]?.status ?? running[session.id]?.status ?? session.status));
  const waiting = groups.waiting.filter(matches), live = groups.running.filter(matches);
  const unread = (filter === "completed" ? completed : groups.unread).filter(matches);
  const pageSize = 15;
  const pageCount = Math.max(1, Math.ceil(unread.length / pageSize));
  const page = Math.min(historyPage, pageCount - 1);
  const historyItems = unread.slice(page * pageSize, (page + 1) * pageSize);
  const recent = [...sessions].sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt)).filter(matches).slice(0, 8);
  const elapsed = (session: UiSession): string => {
    const startedAt = foreground[session.id]?.startedAt ?? running[session.id]?.startedAt;
    if (!startedAt) return "";
    const seconds = Math.max(0, Math.floor((clock - Date.parse(startedAt)) / 1000));
    if (!Number.isFinite(seconds)) return "";
    return zh ? seconds < 60 ? `已运行 ${seconds} 秒` : `已运行 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`;
  };
  const stop = async (session: UiSession): Promise<void> => { setStopping(session.id); try { await stopWorkbenchRun(session.id); } catch (error) { toast.error(String(error)); } finally { setStopping(undefined); } };
  const stateLabel = (session: UiSession): string => {
    const status = foreground[session.id]?.status ?? running[session.id]?.status ?? session.status;
    if (pending[session.id]) return zh ? "待处理" : "Needs attention";
    return ({ running: zh ? "运行中" : "Running", waiting_approval: zh ? "待批准" : "Approval", waiting_input: zh ? "等待输入" : "Awaiting input", cancelled: zh ? "已停止" : "Stopped", failed: zh ? "失败" : "Failed", completed: zh ? "已完成" : "Completed", idle: zh ? "空闲" : "Idle", archived: zh ? "已归档" : "Archived" }[status] ?? status);
  };
  const filters = [{ id: "all", name: zh ? "全部运行" : "All runs", count: groups.waiting.length + groups.running.length + completed.length }, { id: "waiting", name: zh ? "待处理" : "Needs attention", count: groups.waiting.length }, { id: "running", name: zh ? "运行中" : "Running", count: groups.running.length }, { id: "completed", name: zh ? "已完成" : "Completed", count: completed.length }];

  return <div className="run-cockpit" data-design-frame="DZHhW7f99I">
    <header className="cockpit-heading"><div><BarChart3 size={23}/><h1>{t("runsPage.title")}</h1></div><div className="cockpit-top-actions"><label>{t("runsPage.soundToggle")}<Switch checked={notificationSound} onCheckedChange={setNotificationSound} disabled={!notificationsEnabled} aria-label={t("runsPage.soundToggle")}/></label><button type="button" className="cockpit-icon" disabled={refreshing} title={zh ? "刷新运行状态" : "Refresh runs"} aria-label={zh ? "刷新运行状态" : "Refresh runs"} onClick={() => { setRefreshing(true); void hydrateWorkbenchSessions().catch(error => toast.error(String(error))).finally(() => setRefreshing(false)); }}><RefreshCw size={15} className={refreshing ? "animate-spin" : ""}/></button></div></header>
    <div className="cockpit-filterbar"><div role="group" aria-label={zh ? "运行筛选" : "Run filters"}>{filters.map(item => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.name}<b>{item.count}</b></button>)}</div><label className="cockpit-search"><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder={zh ? "搜索任务或项目" : "Search tasks or projects"} aria-label={zh ? "搜索任务或项目" : "Search tasks or projects"}/></label></div>
    <div className="cockpit-grid"><div className="cockpit-primary">
      {(filter === "all" || filter === "waiting") && <section><div className="cockpit-section-heading"><Inbox size={16}/><h2>{zh ? "需要你处理" : "Needs your attention"}</h2><span>{waiting.length}</span></div><div className="cockpit-inbox">{waiting.length ? waiting.map(session => {
        const request = bySession[session.id]?.find(item => item.status === "pending");
        return <article key={session.id} className="cockpit-inbox-row"><ProviderAvatar providerId={provider(session)} size="sm"/><div><div className="cockpit-item-title"><h3>{session.title || t("runsPage.untitled")}</h3><span className="cockpit-attention-label">{request?.kind === "question" ? (zh ? "待回答" : "Question") : (zh ? "待批准" : "Approval")}</span></div><p className="cockpit-item-meta">{meta(session)}</p>{request?.title && <p className="cockpit-item-note" title={request.detail}>{request.title}</p>}</div><button type="button" className="cockpit-button primary" onClick={() => open(session)}>{zh ? "去处理" : "Review"}<ArrowUpRight size={13}/></button></article>;
      }) : <div className="cockpit-empty"><Inbox size={18}/>{zh ? "没有待处理请求" : "No pending requests"}</div>}</div></section>}
      {(filter === "all" || filter === "running") && <section className="cockpit-section"><div className="cockpit-section-heading"><Activity size={16}/><h2>{t("runsPage.running")}</h2><span>{live.length}</span></div>{live.length ? <div className="cockpit-running-grid">{live.map(session => <article key={session.id} className="cockpit-run-card"><div className="cockpit-run-head"><ProviderAvatar providerId={provider(session)} size="sm"/><span><i/>{zh ? "运行中" : "Running"}</span></div><h3>{session.title || t("runsPage.untitled")}</h3><p className="cockpit-item-meta">{meta(session)}</p><div className="cockpit-run-activity"><Activity size={14}/><span>{lastSnippet(events[session.id]) || (zh ? "正在运行" : "Running")}</span></div>{session.model && <p className="cockpit-item-meta">{session.model}</p>}<footer><span>{elapsed(session)}</span><div><button type="button" className="cockpit-icon" title={zh ? "停止运行" : "Stop run"} aria-label={zh ? "停止运行" : "Stop run"} disabled={stopping === session.id} onClick={() => void stop(session)}>{stopping === session.id ? <Loader2 size={13} className="animate-spin"/> : <Square size={12}/>}</button><button type="button" className="cockpit-button" onClick={() => open(session)}>{zh ? "打开会话" : "Open chat"}<ArrowUpRight size={12}/></button></div></footer></article>)}</div> : <div className="cockpit-empty"><Activity size={18}/>{zh ? "没有正在运行的任务" : "No active runs"}</div>}</section>}
      {(filter === "all" || filter === "completed") && <section className="cockpit-section"><div className="cockpit-section-heading"><History size={16}/><h2>{filter === "completed" ? (zh ? "已完成" : "Completed") : t("runsPage.unread")}</h2><span>{unread.length}</span>{groups.unread.length > 0 && <button type="button" onClick={() => markSessionsRead(groups.unread.map(session => session.id))}>{zh ? "全部标为已读" : "Mark all as read"}</button>}</div><div className="cockpit-history">{unread.length ? <><div className="cockpit-history-head"><span>{zh ? "任务" : "Task"}</span><span>Harness</span><span>{zh ? "更新时间" : "Updated"}</span><span/></div>{historyItems.map(session => <button type="button" className="cockpit-history-row" key={session.id} onClick={() => open(session)}><span><FileText size={14}/><strong>{session.title || t("runsPage.untitled")}</strong></span><span>{sessionTargetName(session, teams, instances)}</span><time dateTime={session.lastMessageAt ?? session.updatedAt}>{formatDateTime(session.lastMessageAt ?? session.updatedAt, locale)}</time><ChevronRight size={14}/></button>)}</> : <div className="cockpit-empty"><Check size={18}/>{zh ? "没有未读的完成任务" : "No unread completed tasks"}</div>}</div>{pageCount > 1 && <nav className="cockpit-pagination" aria-label={zh ? "历史记录分页" : "History pages"}><span>{zh ? `共 ${unread.length} 条` : `${unread.length} records`}</span><div><button type="button" disabled={page === 0} onClick={() => setHistoryPage(page - 1)}>{zh ? "上一页" : "Previous"}</button><span>{page + 1} / {pageCount}</span><button type="button" disabled={page === pageCount - 1} onClick={() => setHistoryPage(page + 1)}>{zh ? "下一页" : "Next"}</button></div></nav>}</section>}
    </div><aside className="cockpit-recent"><div className="cockpit-section-heading"><h2>{zh ? "最近更新" : "Recent activity"}</h2></div>{recent.map(session => <button type="button" key={session.id} onClick={() => open(session)} className="cockpit-recent-item"><div><h3>{session.title || t("runsPage.untitled")}</h3><time>{new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(session.lastMessageAt ?? session.updatedAt))}</time></div><p className="cockpit-item-meta">{meta(session)}</p><span className="cockpit-recent-state"><Check size={12}/>{stateLabel(session)}</span></button>)}{!recent.length && <div className="cockpit-empty"><Timer size={17}/>{zh ? "暂无会话动态" : "No recent activity"}</div>}</aside></div>
  </div>;
}
