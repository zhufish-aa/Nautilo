import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  CalendarClock,
  ChevronDown,
  CircleAlert,
  Clock3,
  FileText,
  Folder,
  GitBranch,
  Activity,
  Layers3,
  MessageSquareQuote,
  Workflow,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  Square,
} from "lucide-react";
import type { AssistantDispatch, AssistantSessionPage, AssistantSession } from "@agenthub/schemas";
import {
  activityOf,
  type AssistantLiveOutput,
  type AssistantReceipt,
  type AssistantRoutineInput,
  type AssistantTurn,
  type AssistantView,
  type JournalRow,
} from "../../../../shared/workspace-assistant";
import { getBridge, requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { sessionLocation } from "../../lib/sidebar-navigation";
import { MarkdownContent } from "../timeline/MarkdownContent";
import { assistantError } from "./AssistantSettingsPanel";
import { AssistantEffort } from "./AssistantEffort";
import { connectionModelKey, useConnectionsStore } from "../../stores/connections";
import { useProvidersStore } from "../../stores/providers";
import { NautiloMark, ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { markOutgoingMessage, useMessageEntrance, useSurfaceEntrance } from "../../lib/ui-motion";
import { AssistantAutomationsDialog } from "./AssistantAutomationsDialog";
import "./assistant.css";

const states: Record<string, [string, string]> = {
  idle: ["空闲", "Idle"],
  running: ["运行中", "Working"],
  waiting_input: ["待回复", "Needs a reply"],
  waiting_approval: ["待审批", "Needs approval"],
  completed: ["已完成", "Completed"],
  cancelled: ["已停止", "Stopped"],
  failed: ["失败", "Failed"],
  archived: ["已归档", "Archived"],
};
const stages: Record<string, [string, string]> = {
  thinking: ["正在思考", "Thinking"],
  list_workspace: ["正在查项目", "Checking projects"],
  list_sessions: ["正在查会话", "Finding sessions"],
  read_session: ["正在查看相关消息", "Reading excerpts"],
  find_history: ["正在查派发记录", "Reading history"],
  watch_session: ["正在关注会话", "Following session"],
  follow_topic: ["正在记录待跟进事项", "Saving a follow-up"],
  send_task: ["正在派发任务", "Assigning task"],
  create_session: ["正在创建会话", "Creating session"],
  compacting: ["正在整理助手记忆", "Compacting memory"],
  stopping: ["正在停止", "Stopping"],
};
const bubbleEntrance = {
  keyframes: [
    { opacity: 0, transform: "translateY(10px) scale(.97)" },
    { opacity: 1, transform: "translateY(0) scale(1)" },
  ],
  options: { duration: 280, easing: "cubic-bezier(0.22, 1.18, 0.36, 1)" },
};
function statusLabel(value: string, zh: boolean) {
  return states[value]?.[zh ? 0 : 1] ?? value;
}
function activityGroup(session: AssistantSession) {
  const status = activityOf(session);
  if (status === "waiting_input" || status === "waiting_approval" || status === "failed") return "attention";
  return status === "running" ? "running" : "recent";
}
function HarnessMark({ name }: { name: string }) {
  const catalog = useProvidersStore((state) => state.catalog);
  const key = name.toLowerCase();
  const provider = catalog.find(
    (item) => item.providerId.toLowerCase() === key || item.name.toLowerCase() === key,
  );
  return (
    <div className="as-harness-mark" aria-hidden>
      <ProviderAvatar providerId={provider?.providerId ?? key.replace(/\s+/g, "-")} size="sm" />
    </div>
  );
}

function AssistantAvatar({ online }: { online?: boolean }) {
  return <span className="as-avatar" aria-hidden>
    <NautiloMark />
    {online && <span className="as-presence" data-state="online" />}
  </span>;
}
function MessageDate({ at, zh }: { at: string; zh: boolean }) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const format: Intl.DateTimeFormatOptions = { month: "long", day: "numeric" };
  if (date.getFullYear() !== new Date().getFullYear()) format.year = "numeric";
  return <div className="as-date"><time dateTime={at}>{date.toLocaleDateString(zh ? "zh-CN" : "en", format)}</time></div>;
}
function ShortTime({ at, zh, clock = false }: { at: string; zh: boolean; clock?: boolean }) {
  const date = new Date(at);
  const today = clock || date.toDateString() === new Date().toDateString();
  const locale = zh ? "zh-CN" : "en";
  const format = useMemo(
    () =>
      new Intl.DateTimeFormat(
        locale,
        today ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { month: "short", day: "numeric" },
      ),
    [locale, today],
  );
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time className="as-time" dateTime={at} title={date.toLocaleString(locale)}>
      {format.format(date)}
    </time>
  );
}
function ActivityDrawer({
  children,
  onClose,
  label,
}: {
  children: ReactNode;
  onClose: () => void;
  label: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="as-activity-drawer"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== dialog.current) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          onClose();
      }}
    >
      {children}
    </dialog>
  );
}

function SessionRail({
  zh, items, more, onMore, onClose, error, attention, setAttention, quote, focusChat, latest, online,
}: {
  zh: boolean;
  items: AssistantSession[];
  more: boolean;
  error: string;
  onMore: () => void;
  onClose: () => void;
  attention: boolean;
  setAttention: (value: boolean) => void;
  quote: (session: AssistantSession) => void;
  focusChat: () => void;
  latest?: string;
  online: boolean;
}) {
  const attentionCount = items.filter(session => activityGroup(session) === "attention").length;
  const visible = attention ? items.filter(session => activityGroup(session) === "attention") : items;
  return (
    <aside className="as-rail" id="assistant-activity" aria-labelledby="assistant-activity-title">
      <div className="as-rail-heading">
        <h2 id="assistant-activity-title">{zh ? "消息" : "Messages"}</h2>
        <button type="button" className="as-icon" onClick={onClose} aria-label={zh ? "收起会话列表" : "Hide session list"}>
          <PanelLeftClose size={16} aria-hidden />
        </button>
      </div>
      <div className="as-tabs" role="group" aria-label={zh ? "筛选会话" : "Filter sessions"}>
        <button type="button" aria-pressed={!attention} onClick={() => setAttention(false)}>{zh ? "全部" : "All"}</button>
        <button type="button" aria-pressed={attention} onClick={() => setAttention(true)}>
          {zh ? "待处理" : "Needs attention"}
          {attentionCount > 0 && <span className="as-filter-count">{attentionCount}</span>}
        </button>
      </div>
      <div className="as-session-list">
        <button type="button" className="as-rail-current" aria-current="page" onClick={focusChat}>
          <AssistantAvatar online={online} />
          <span className="as-session-body">
            <span className="as-session-heading">
              <strong>{zh ? "工作区助手" : "Workspace assistant"}</strong>
              <small>{zh ? "置顶" : "Pinned"}</small>
            </span>
            <span className="as-rail-preview">{latest || (online
              ? (zh ? "暂无消息" : "No messages yet")
              : (zh ? "等待配置" : "Setup required"))}</span>
          </span>
        </button>
        {error ? <p className="as-list-error" role="alert">{error}</p> : null}
        {!!visible.length && <h3 className="as-session-caption">{attention
          ? (zh ? "需要你处理" : "Needs your attention")
          : (zh ? "最近会话" : "Recent sessions")}</h3>}
        {visible.map(session => {
          const status = activityOf(session);
          return (
            <div className="as-session" data-state={status} key={session.id}>
              <Link className="as-session-link" to={sessionLocation({ id: session.id })} title={session.title}>
                <div className="as-session-avatar">
                  <HarnessMark name={session.harness} />
                  <span className="as-presence" data-state={status} aria-hidden />
                </div>
                <div className="as-session-body">
                  <div className="as-session-heading">
                    <span className="as-session-title">{session.title}</span>
                    <ShortTime at={session.updatedAt} zh={zh} />
                  </div>
                  <div className="as-session-meta">
                    <span className="as-session-project">{[session.project || session.projectId, session.harness].filter(Boolean).join(" · ")}</span>
                    <span className="as-state" data-state={status}>{statusLabel(status, zh)}</span>
                  </div>
                </div>
              </Link>
              <button type="button" className="as-quote as-icon" title={zh ? "引用给助手" : "Reference in assistant"}
                aria-label={zh ? `引用「${session.title}」给助手` : `Reference ${session.title} in assistant`}
                onClick={() => quote(session)}>
                <MessageSquareQuote size={14} aria-hidden />
              </button>
            </div>
          );
        })}
        {!visible.length && !error && <p className="as-empty-activity">{attention
          ? (zh ? "当前没有待处理的会话" : "No sessions need attention")
          : (zh ? "暂无会话" : "No sessions yet")}</p>}
      </div>
      {more && <footer className="as-rail-footer">
        <button type="button" className="as-text-button as-session-more" onClick={onMore}>
          {zh ? "加载更多会话" : "More sessions"}<ArrowDown size={13} aria-hidden />
        </button>
      </footer>}
    </aside>
  );
}
function DeliveryReceipt({
  receipt: r,
  session,
  dispatch,
  zh,
}: {
  receipt: AssistantReceipt;
  session?: AssistantSession;
  dispatch?: AssistantDispatch;
  zh: boolean;
}) {
  const execution = dispatch?.status;
  const openReceipt = r.delivery === "sent" || r.delivery === "queued";
  const state = openReceipt && execution && states[execution] ? execution : undefined;
  const Icon = state === "completed" ? Check : state === "failed" ? CircleAlert :
    state ? Clock3 : { pending: Clock3, sent: Check, queued: Clock3, failed: CircleAlert }[r.delivery];
  const label = {
    pending: zh ? "送达待确认" : "Delivery unconfirmed",
    sent: r.task ? (zh ? "已派发" : "Assigned") : (zh ? "已创建" : "Created"),
    queued: zh ? "已加入会话队列" : "Queued in session",
    failed: zh ? "派发失败" : "Delivery failed",
  }[r.delivery];
  const location = sessionLocation({ id: r.sessionId });
  return (
    <section className="as-delivery" data-delivery={r.delivery} aria-label={zh ? "任务派发回执" : "Task delivery"}>
      <Link className="as-receipt" to={location}>
        <span className="as-receipt-symbol" aria-hidden><GitBranch size={19} /></span>
        <div className="as-receipt-body">
          <h3>{r.title}</h3>
          <div className="as-receipt-context">
            <Folder size={13} aria-hidden /><span>{r.project}</span>
            {session?.harness && (
              <>
                <span className="as-context-divider" aria-hidden />
                <HarnessMark name={session.harness} /><span>{session.harness}</span>
              </>
            )}
          </div>
        </div>
        <span className="as-delivery-state"><Icon size={13} aria-hidden />{state ? statusLabel(state, zh) : label}</span>
      </Link>
      {r.error && <p className="as-delivery-error" role="alert">{r.error}</p>}
      <div className="as-delivery-footer">
        {r.task && (
          <details className="as-delivery-detail">
            <summary><FileText size={14} aria-hidden /><span>{zh ? "派发内容" : "Assignment"}</span><ChevronDown size={12} aria-hidden /></summary>
            <p>{r.task}</p>
          </details>
        )}
        <Link className="as-receipt-open" to={location}>
          {zh ? "打开会话" : "Open session"}<ArrowUpRight size={14} aria-hidden />
        </Link>
      </div>
    </section>
  );
}

function Turn({
  row,
  zh,
  stage,
  liveText,
  sessions,
  dispatches,
  onJump,
  onReviewAutomation,
  onStop,
}: {
  row: JournalRow<AssistantTurn>;
  zh: boolean;
  stage?: string;
  liveText?: string;
  sessions: ReadonlyMap<string, AssistantSession>;
  dispatches: ReadonlyMap<string, AssistantDispatch>;
  onJump: (seq: number) => void;
  onReviewAutomation: (id: string, data: AssistantRoutineInput) => void;
  onStop: (id: string) => void;
}) {
  const { value: t } = row,
    live = t.status === "running" || t.status === "queued";
  const entranceRef = useMessageEntrance("workspace-assistant", t.id, bubbleEntrance);
  const reply = t.reply || (live ? liveText : undefined);
  const activity = t.status === "queued" ? (zh ? "已排队" : "Queued")
    : (stages[stage ?? "thinking"] ?? stages.thinking)![zh ? 0 : 1];
  const typing = t.status === "running" && !reply;
  const hasBubble = reply || live || t.source || t.routineDraft || t.receipts.length > 0;
  return (
    <article id={`as-turn-${row.seq}`} tabIndex={-1} className="as-turn">
      {!!t.text && <div ref={entranceRef} className="as-message-row as-user-turn">
        <h2 className="sr-only">{zh ? "你" : "You"}</h2>
        <div className="as-user-message">{t.text}</div>
        <ShortTime at={t.at} zh={zh} clock />
      </div>}
      {(hasBubble || t.status === "stopped" || t.usage) && (
        <div ref={t.text ? undefined : entranceRef} className="as-message-row as-response">
          <AssistantAvatar />
          <h2 className="sr-only">{zh ? "工作区助手" : "Workspace assistant"}</h2>
          {hasBubble && <div className="as-bubble" data-typing={typing || undefined}>
            {live && <div className="as-bubble-status">
              {typing && <span className="as-typing-dots" aria-hidden><i /><i /><i /></span>}
              <span className={typing && stage === "thinking" ? "sr-only" : "as-stage"} role="status">{activity}</span>
              {t.status === "queued" && <button type="button" className="as-icon" onClick={() => onStop(t.id)}
                aria-label={zh ? "停止这条指令" : "Stop request"}>
                <Square size={11} aria-hidden />
              </button>}
            </div>}
            {reply && (
              <div className={"as-answer" + (t.status === "error" ? " as-error" : "")}
                role={t.status === "error" ? "alert" : undefined}>
                <MarkdownContent source={reply} streaming={live}
                  scrollableTableLabel={zh ? "回复中的表格" : "Table in assistant reply"} />
              </div>
            )}
            {t.source && <div className="as-source-links">
              {t.source.turnSeq && <button className="as-text-button" onClick={() => onJump(t.source!.turnSeq!)}>{zh ? "查看原对话消息" : "Original message"}</button>}
              {t.source.sessionId && <Link className="as-text-button" to={sessionLocation({ id: t.source.sessionId })}>{zh ? "打开执行会话" : "Open worker session"}</Link>}
            </div>}
            {t.routineDraft && <button type="button" className="as-text-button" onClick={() => onReviewAutomation(t.id, t.routineDraft!)}>
              <CalendarClock size={14} aria-hidden />{zh ? "查看并确认自动任务" : "Review automation draft"}
            </button>}
            {t.receipts.map(r => (
              <DeliveryReceipt key={r.messageId} receipt={r} session={sessions.get(r.sessionId)} dispatch={dispatches.get(r.messageId)} zh={zh} />
            ))}
          </div>}
          <div className="as-message-meta">
            <ShortTime at={t.at} zh={zh} clock />
            {t.status === "stopped" && <span className="as-stopped">{zh ? "已停止" : "Stopped"}</span>}
            {!live && t.usage && (
              <small className="as-usage"
                title={zh
                  ? "本轮各次调度请求的输入合计，包含已报告的缓存命中，不含回复输出。"
                  : "Input summed across routing calls, including reported cache hits. Output is excluded."}>
                <Layers3 size={12} aria-hidden />
                <span>
                  {zh ? "输入" : "Input"} {t.usage.input.toLocaleString()} tokens
                  {typeof t.usage.cached === "number" && <> · {zh ? "缓存命中" : "Cache read"} {t.usage.cached.toLocaleString()}</>}
                </span>
              </small>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

export default function AssistantPage() {
  const zh = useI18n().locale === "zh-CN",
    api = getBridge()?.assistant;
  const [view, setView] = useState<AssistantView>(),
    [older, setOlder] = useState<JournalRow<AssistantTurn>[]>([]);
  const [olderDispatches, setOlderDispatches] = useState<AssistantDispatch[]>([]);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [routineDraft, setRoutineDraft] = useState<{ id: string; data: AssistantRoutineInput }>();
  const [hasOlder, setHasOlder] = useState(true);
  const [compact, setCompact] = useState(false);
  const [railDocked, setRailDocked] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const rail = compact ? drawerOpen : railDocked;
  const setRail = compact ? setDrawerOpen : setRailDocked;
  const pageRoot = useSurfaceEntrance<HTMLElement>("workspace-assistant");
  useLayoutEffect(() => {
    const el = pageRoot.current;
    if (!el) return;
    const measure = () => {
      const narrow = el.clientWidth < 870;
      setCompact(narrow);
      if (!narrow) setDrawerOpen(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [page, setPage] = useState<AssistantSessionPage>({ items: [], next: null }),
    [pageCount, setPageCount] = useState(1);
  const sessionsById = useMemo(() => new Map(page.items.map((session) => [session.id, session])), [page.items]);
  const [attention, setAttention] = useState(false);
  const [activityError, setActivityError] = useState(""),
    [viewError, setViewError] = useState("");
  const [draft, setDraft] = useState(""),
    [sending, setSending] = useState(false),
    [error, setError] = useState("");
  const [stream, setStream] = useState<AssistantLiveOutput>();
  const connections = useConnectionsStore((s) => s.connections);
  useEffect(() => {
    void useConnectionsStore.getState().hydrate();
  }, []);
  const [effortSaving, setEffortSaving] = useState(false);
  const scroll = useRef<HTMLDivElement>(null),
    dock = useRef<HTMLDivElement>(null),
    stick = useRef(true),
    input = useRef<HTMLTextAreaElement>(null);
  const generation = useRef(0),
    pendingSubmission = useRef<{ id: string; text: string }>();
  const scrollToEnd = useCallback(() => {
    const element = scroll.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, []);
  useLayoutEffect(() => {
    const element = dock.current;
    if (!element?.parentElement) return;
    const chat = element.parentElement;
    const observer = new ResizeObserver(() => {
      chat.style.setProperty("--as-dock-height", element.offsetHeight + "px");
      scrollToEnd();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollToEnd]);
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try {
      const snapshot = await api?.view();
      if (snapshot && generation.current === version) {
        setView(snapshot);
        setStream((current) => {
          const next = snapshot.liveOutput;
          if (current && next?.stepId === current.stepId && current.text.length > next.text.length)
            return current;
          if (
            !next &&
            current &&
            snapshot.stage === "thinking" &&
            snapshot.turns.some((t) => t.value.id === current.turnId && t.value.status === "running")
          )
            return current;
          return next;
        });
        setViewError("");
      }
    } catch (e) {
      if (generation.current === version) setViewError(assistantError(e));
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    const unsubscribe = api?.onOutput?.(setStream);
    const off = api?.onChange(() => void refresh());
    return () => {
      generation.current++;
      off?.();
      unsubscribe?.();
    };
  }, [api, refresh]);
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const items: AssistantSession[] = [];
        let next: number | null = 0;
        for (let i = 0; i < pageCount && next !== null && !disposed; i++) {
          const data: AssistantSessionPage = await requestCore("assistant.sessions", { skip: next });
          items.push(...data.items);
          next = data.next;
        }
        const pending = await requestCore<Array<{ sessionId: string; kind: string }>>("interaction.list", {
          status: "pending",
        });
        const pendingById = new Map(pending.map(item => [item.sessionId, item.kind]));
        if (attention) {
          const loaded = new Set(items.map(item => item.id));
          const missing = [...pendingById.keys()].filter(id => !loaded.has(id)).slice(0, 24);
          const extra = await Promise.all(missing.map(sessionId => requestCore<AssistantSessionPage>("assistant.sessions", { sessionId })));
          items.push(...extra.flatMap(item => item.items));
        }
        const sessions = items.map(session => {
          const kind = pendingById.get(session.id);
          return kind ? { ...session, status: kind === "approval" ? "waiting_approval" : "waiting_input" } : session;
        }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (!disposed) {
          setPage({ items: sessions, next });
          setActivityError("");
        }
      } catch (e) {
        if (!disposed) setActivityError(assistantError(e));
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 3500);
      }
    };
    if (rail) void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [rail, pageCount, attention]);
  const turns = Array.from(
    new Map([...older, ...(view?.turns ?? [])].map((row) => [row.seq, row])).values(),
  ).sort((a, b) => a.seq - b.seq);
  const dispatches = new Map([...olderDispatches, ...(view?.dispatches ?? [])].map(item => [item.messageId, item]));
  useEffect(() => {
    scrollToEnd();
  }, [
    stream?.text,
    view?.turns.at(-1)?.seq,
    view?.turns.at(-1)?.value.reply,
    view?.turns.at(-1)?.value.status,
    view?.stage,
    view?.turns.at(-1)?.value.receipts.length,
    scrollToEnd,
  ]);
  const loadOlder = async () => {
    const first = turns[0];
    if (!api || !first) return;
    try {
      const prev = await api.view(first.seq);
      stick.current = false;
      setOlder((current) => [...prev.turns, ...current, ...(view?.turns ?? [])]);
      setOlderDispatches((current) => [...prev.dispatches, ...current, ...(view?.dispatches ?? [])]);
      setHasOlder(prev.turns.length === 20);
    } catch (e) {
      setError(assistantError(e));
    }
  };
  const jumpToTurn = async (seq: number) => {
    setAutomationOpen(false);
    stick.current = false;
    const reveal = () => {
      const item = document.getElementById(`as-turn-${seq}`);
      item?.focus({ preventScroll: true });
      item?.scrollIntoView({ block: "center" });
    };
    if (document.getElementById(`as-turn-${seq}`)) {
      requestAnimationFrame(reveal);
      return;
    }
    try {
      const snapshot = await api?.view(seq + 1);
      if (!snapshot) return;
      setOlder(known => [...snapshot.turns, ...known]);
      setOlderDispatches(known => [...snapshot.dispatches, ...known]);
      requestAnimationFrame(() => requestAnimationFrame(reveal));
    } catch (failure) {
      setError(assistantError(failure));
    }
  };
  const send = async (text = draft) => {
    if (!text.trim() || !api || !view?.settings.model || sending) return;
    setSending(true);
    setError("");
    stick.current = true;
    try {
      const body = text.trim();
      if (pendingSubmission.current?.text !== body)
        pendingSubmission.current = { id: "turn_" + crypto.randomUUID(), text: body };
      markOutgoingMessage("workspace-assistant", pendingSubmission.current.id);
      await api.submit(pendingSubmission.current.id, body);
      pendingSubmission.current = undefined;
      setDraft((current) => (current.trim() === body ? "" : current));
      await refresh();
      input.current?.focus();
    } catch (e) {
      setError(assistantError(e));
    } finally {
      setSending(false);
    }
  };
  const ready = !!view?.settings.model;
  const selectedConnection = connections.find((c) => c.id === view?.settings.connectionId);
  const accountId = selectedConnection?.accountGateway && !selectedConnection.models?.length ? selectedConnection.id : undefined;
  const revision = selectedConnection?.revision;
  const catalogKey = accountId && revision !== undefined ? connectionModelKey(accountId, revision) : undefined;
  const catalog = useConnectionsStore((state) => catalogKey ? state.modelCatalogs[catalogKey] : undefined);
  useEffect(() => {
    if (accountId) void useConnectionsStore.getState().loadModels(accountId, revision);
  }, [accountId, revision]);
  const selectedModel = (accountId ? catalog?.models : selectedConnection?.models)?.find((m) => m.id === view?.settings.model);
  const saveEffort = async (reasoningEffort: string | undefined) => {
    if (!api || !view || effortSaving) return;
    setEffortSaving(true);
    try {
      await api.configure({ ...view.settings, reasoningEffort });
      await refresh();
    } catch (e) {
      setError(assistantError(e));
    } finally {
      setEffortSaving(false);
    }
  };
  const suggest = (text: string) => {
    setDraft(text);
    if (compact) setDrawerOpen(false);
    requestAnimationFrame(() => input.current?.focus());
  };
  const actions = [
    {
      Icon: Workflow,
      title: zh ? "分派任务" : "Assign a task",
      prompt: zh ? "帮我把这个任务分派到合适的会话：" : "Assign this task to the right session: ",
    },
    {
      Icon: Activity,
      title: zh ? "查看进展" : "Check progress",
      prompt: zh ? "我的会话最近都在做什么？" : "What are my sessions working on?",
    },
    {
      Icon: MessageSquareQuote,
      title: zh ? "待我处理" : "Needs my attention",
      prompt: zh ? "哪些会话正在等我回复或审批？" : "Which sessions need a reply or approval?",
    },
  ];
  const activityLabel = zh ? "会话列表" : "Session list";
  const activityPanel = rail && (
    <SessionRail
      zh={zh}
      error={activityError}
      attention={attention}
      setAttention={setAttention}
      items={page.items}
      more={page.next !== null}
      onMore={() => setPageCount((c) => c + 1)}
      onClose={() => setRail(false)}
      latest={turns.at(-1)?.value.reply ?? turns.at(-1)?.value.text}
      online={ready}
      focusChat={() => {
        if (compact) setDrawerOpen(false);
        requestAnimationFrame(() => input.current?.focus());
      }}
      quote={(session) => suggest(zh ? `帮我看看「${session.title}」目前的进展：` : `Check the current progress of “${session.title}”:`)}
    />
  );
  return (
    <section ref={pageRoot} className="as-page">
      {compact && drawerOpen ? (
        <ActivityDrawer label={activityLabel} onClose={() => setDrawerOpen(false)}>{activityPanel}</ActivityDrawer>
      ) : activityPanel}
      {automationOpen && api && <AssistantAutomationsDialog api={api} initialDraft={routineDraft} close={() => setAutomationOpen(false)} openTurn={seq => void jumpToTurn(seq)} />}
      <div className="as-chat">
          <header className="as-header">
            <div className="as-header-identity">
              {(!rail || compact) && (
                <button type="button" className="as-icon" onClick={() => setRail(true)}
                  aria-expanded={rail} aria-controls={rail ? "assistant-activity" : undefined}
                  aria-label={zh ? "展开会话列表" : "Show session list"} title={activityLabel}>
                  <PanelLeftOpen size={17} aria-hidden />
                </button>
              )}
              <AssistantAvatar online={ready} />
              <div className="as-header-copy">
                <h1 title={view?.memoryAt ? ((zh ? "记忆上次整理 " : "Memory updated ") + new Date(view.memoryAt).toLocaleString()) : undefined}>
                  {zh ? "工作区助手" : "Workspace assistant"}
                </h1>
                <span className="as-header-status" data-online={ready && !view?.busy || undefined} aria-live="polite">{view?.busy
                  ? (zh ? "正在思考…" : "Thinking…")
                  : ready ? (zh ? "在线" : "Online") : (zh ? "等待配置" : "Setup required")}</span>
              </div>
            </div>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="as-icon as-header-settings" aria-label={zh ? "助手设置" : "Assistant settings"}>
                  <Settings2 size={17} aria-hidden />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6} className="as-toolbar-menu">
                  <DropdownMenu.Item asChild>
                    <Link to="/settings?section=assistant" state={{ returnTo: "/assistant" }}>
                      <Settings2 size={14} aria-hidden />{zh ? "助手设置" : "Assistant settings"}
                    </Link>
                  </DropdownMenu.Item>
                  {api?.automations && <DropdownMenu.Item onSelect={() => { setRoutineDraft(undefined); setAutomationOpen(true); }}>
                    <CalendarClock size={14} aria-hidden />{zh ? "自动任务与跟进" : "Automations and follow-ups"}
                  </DropdownMenu.Item>}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </header>
          <div
            className="as-scroll"
            ref={scroll}
            onScroll={() => {
              const el = scroll.current;
              if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            }}
          >
            {turns.length ? (
              <div className="as-thread">
                {turns.length >= 20 && hasOlder && (
                  <button className="as-text-button" onClick={() => void loadOlder()}>
                    {zh ? "查看更早的对话" : "Earlier messages"}
                  </button>
                )}
                {turns.map((row, index) => (
                  <Fragment key={row.seq}>
                  {new Date(row.value.at).toDateString() !== new Date(turns[index - 1]?.value.at ?? "").toDateString() &&
                    <MessageDate at={row.value.at} zh={zh} />}
                  <Turn
                    row={row}
                    zh={zh}
                    sessions={sessionsById}
                    dispatches={dispatches}
                    onJump={(seq) => void jumpToTurn(seq)}
                    onReviewAutomation={(id, data) => { setRoutineDraft({ id, data }); setAutomationOpen(true); }}
                    stage={view?.stage}
                    liveText={
                      stream?.turnId === row.value.id && view?.stage === "thinking" ? stream.text : undefined
                    }
                    onStop={(id) => void api?.stop(id).catch((e) => setError(assistantError(e)))}
                  />
                  </Fragment>
                ))}
              </div>
            ) : (
              <div className="as-welcome">
                <AssistantAvatar />
                <h2>{zh ? "工作区助手" : "Workspace assistant"}</h2>
                <p>{zh ? "像跟同事发消息一样，随时问我任何会话的进展。" : "Message me like a teammate and ask about any session."}</p>
                <div className="as-actions">
                  {actions.map(({ Icon, title, prompt }) => (
                    <button type="button" key={title} onClick={() => suggest(prompt)}>
                      <Icon size={14} aria-hidden />{title}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="as-dock" ref={dock}>
            <div className="as-dock-inner">
            {(error || viewError) && (
              <p role="alert" className="as-error">
                {error || viewError}
              </p>
            )}
            <form
              className="as-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <div className="as-entry">
                <label className="sr-only" htmlFor="assistant-message">
                  {zh ? "给助手" : "To assistant"}
                </label>
                <textarea
                  id="assistant-message"
                  ref={input}
                  placeholder={zh ? "给工作区助手发消息…" : "Message the workspace assistant…"}
                  rows={1}
                  value={draft}
                  maxLength={16000}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
              </div>
              <div className="as-composer-bar">
                <Link
                  to="/settings?section=assistant"
                  state={{ returnTo: "/assistant" }}
                  title={view?.settings.model || (zh ? "选择助手模型" : "Choose an assistant model")}
                >
                  <Layers3 size={17} />
                  <span>
                    {selectedModel?.displayName ||
                      view?.settings.model ||
                      (zh ? "选择助手模型" : "Choose a model")}
                  </span>
                </Link>
                {!!selectedModel?.reasoningEfforts?.length && (
                  <div className="as-effort-control">
                    <AssistantEffort
                      compact
                      model={selectedModel}
                      value={view?.settings.reasoningEffort}
                      disabled={effortSaving}
                      onChange={(effort) => void saveEffort(effort)}
                    />
                  </div>
                )}
                {view?.busy && view.turns.some(row => row.value.status === "running") ? <button
                  type="button" className="as-send" aria-label={zh ? "停止生成" : "Stop response"}
                  onClick={() => {
                    const current = view.turns.find(row => row.value.status === "running");
                    if (current) void api?.stop(current.value.id).catch(e => setError(assistantError(e)));
                  }}>
                  <Square size={13} aria-hidden />
                </button> : <button
                  type="submit"
                  className="as-send"
                  disabled={!ready || !draft.trim() || sending}
                  aria-label={zh ? "发送指令" : "Send request"}
                  title={zh ? "Enter 发送，Shift + Enter 换行" : "Enter to send, Shift + Enter for a new line"}
                >
                  <ArrowUp size={20} />
                </button>}
              </div>
            </form>
            </div>
          </div>
      </div>
    </section>
  );
}
