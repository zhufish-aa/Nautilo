import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Activity,
  BellDot,
  CornerDownRight,
  Layers3,
  Workflow,
  PanelRightClose,
  PanelRightOpen,
  Settings2,
  CheckCheck,
  Square,
} from "lucide-react";
import type { AssistantSessionPage, AssistantSession } from "@agenthub/schemas";
import {
  activityOf,
  type AssistantLiveOutput,
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
import { useConnectionsStore } from "../../stores/connections";
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
  send_task: ["正在派发任务", "Assigning task"],
  create_session: ["正在创建会话", "Creating session"],
  compacting: ["正在整理助手记忆", "Compacting memory"],
  stopping: ["正在停止", "Stopping"],
};
function statusLabel(value: string, zh: boolean) {
  return states[value]?.[zh ? 0 : 1] ?? value;
}
function activityGroup(session: AssistantSession) {
  const status = activityOf(session);
  if (status === "waiting_input" || status === "waiting_approval") return "attention";
  return status === "running" ? "running" : "recent";
}
function ShortTime({ at, zh }: { at: string; zh: boolean }) {
  const date = new Date(at);
  const today = date.toDateString() === new Date().toDateString();
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
  zh,
  items,
  more,
  onMore,
  onClose,
  error,
  attention,
  setAttention,
}: {
  zh: boolean;
  items: AssistantSession[];
  more: boolean;
  error: string;
  onMore: () => void;
  onClose: () => void;
  attention: boolean;
  setAttention: (value: boolean) => void;
}) {
  const ordered = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const groups = [
    { key: "attention", label: zh ? "需要你处理" : "Needs your attention" },
    { key: "running", label: zh ? "运行中" : "In progress" },
    { key: "recent", label: zh ? "最近更新" : "Recently updated" },
  ]
    .filter((group) => !attention || group.key === "attention")
    .map((group) => ({ ...group, rows: ordered.filter((s) => activityGroup(s) === group.key) }))
    .filter((group) => group.rows.length);
  return (
    <aside className="as-rail" id="assistant-activity" aria-labelledby="assistant-activity-title">
      <div className="as-rail-heading">
        <div>
          <Activity size={17} aria-hidden />
          <h2 id="assistant-activity-title">{zh ? "会话动态" : "Session activity"}</h2>
        </div>
        <button className="as-icon" onClick={onClose} aria-label={zh ? "收起会话动态" : "Hide activity"}>
          <PanelRightClose size={16} />
        </button>
      </div>
      <div className="as-tabs" role="group" aria-label={zh ? "筛选会话" : "Filter sessions"}>
        <button aria-pressed={!attention} onClick={() => setAttention(false)}>
          {zh ? "全部" : "All"}
        </button>
        <button aria-pressed={attention} onClick={() => setAttention(true)}>
          {zh ? "待处理" : "Needs attention"}
        </button>
      </div>
      <div className="as-session-list">
        {error && (
          <p className="as-list-error" role="alert">
            {error}
          </p>
        )}
        {groups.map((group) => (
          <section className="as-session-group" key={group.key} data-group={group.key}>
            {!attention && <h3>{group.label}</h3>}
            {group.rows.map((s) => {
              const status = activityOf(s);
              return (
                <Link
                  className="as-session"
                  data-state={status}
                  key={s.id}
                  to={sessionLocation({ id: s.id })}
                  title={s.title}
                >
                  <span className="as-session-heading">
                    <span className="as-session-title">{s.title}</span>
                    <ShortTime at={s.updatedAt} zh={zh} />
                  </span>
                  <span className="as-session-meta">
                    <span className="as-session-project">
                      {[s.project || s.projectId, s.harness].filter(Boolean).join(" · ")}
                    </span>
                    <span className="as-state">
                      <i aria-hidden />
                      {statusLabel(status, zh)}
                    </span>
                  </span>
                </Link>
              );
            })}
          </section>
        ))}
        {!groups.length && !error && (
          <p className="as-empty-activity">
            <CheckCheck size={18} aria-hidden />
            {attention
              ? zh
                ? "当前没有待处理的会话"
                : "No sessions need attention"
              : zh
                ? "暂无会话"
                : "No sessions yet"}
          </p>
        )}
        {more && (
          <button className="as-text-button" onClick={onMore}>
            {zh ? "加载更多会话" : "More sessions"}
            <ArrowDown size={13} />
          </button>
        )}
      </div>
    </aside>
  );
}

function Turn({
  row,
  zh,
  stage,
  liveText,
  onStop,
}: {
  row: JournalRow<AssistantTurn>;
  zh: boolean;
  stage?: string;
  liveText?: string;
  onStop: (id: string) => void;
}) {
  const { value: t } = row,
    live = t.status === "running" || t.status === "queued";
  return (
    <article className="as-turn">
      <div className="as-user-message">{t.text}</div>
      <div className="as-response">
        <span className="as-avatar" aria-hidden>
          <Workflow size={15} strokeWidth={1.9} />
        </span>
        <div className="as-response-body">
          <div className="as-turn-heading">
            <h2>{zh ? "助手" : "Assistant"}</h2>
            <ShortTime at={t.at} zh={zh} />
            {live && (
              <span className="as-stage" role="status">
                {t.status === "queued"
                  ? zh
                    ? "已排队"
                    : "Queued"
                  : (stages[stage ?? "thinking"] ?? stages.thinking)![zh ? 0 : 1]}
              </span>
            )}
            {t.status === "stopped" && <span className="as-stopped">{zh ? "已停止" : "Stopped"}</span>}
            {live && (
              <button
                className="as-icon"
                onClick={() => onStop(t.id)}
                aria-label={zh ? "停止这条指令" : "Stop request"}
              >
                <Square size={11} />
              </button>
            )}
          </div>
          {(t.reply || (live && liveText)) && (
            <div
              className={"as-answer" + (t.status === "error" ? " as-error" : "")}
              role={t.status === "error" ? "alert" : undefined}
            >
              <MarkdownContent
                source={t.reply ?? liveText ?? ""}
                streaming={live}
                scrollableTableLabel={zh ? "回复中的表格" : "Table in assistant reply"}
              />
            </div>
          )}
          {t.receipts.map((r) => (
            <div className="as-delivery" key={r.messageId} data-delivery={r.delivery}>
              <Link className="as-receipt" to={sessionLocation({ id: r.sessionId })}>
                <CornerDownRight size={16} />
                <span>
                  <strong>{r.title}</strong>
                  <small>
                    {r.project} ·{" "}
                    {
                      {
                        pending: zh ? "送达待确认" : "Delivery unconfirmed",
                        sent: zh ? "已派发" : "Assigned",
                        queued: zh ? "已加入会话队列" : "Queued in session",
                        failed: zh ? "派发失败" : "Delivery failed",
                      }[r.delivery]
                    }
                    {r.error ? " · " + r.error : ""}
                  </small>
                </span>
                <ChevronRight size={15} />
              </Link>
              {r.task && (
                <details className="as-delivery-detail">
                  <summary>
                    <ChevronRight size={12} aria-hidden />
                    {zh ? "查看派发内容" : "View assignment"}
                  </summary>
                  <p>{r.task}</p>
                </details>
              )}
            </div>
          ))}
          {!live && typeof t.usage?.cached === "number" && (
            <small
              className="as-usage"
              title={
                zh ? "供应商返回的本轮调度请求合计" : "Totals reported by the model provider for this request"
              }
            >
              <Layers3 size={12} aria-hidden />
              {zh ? "缓存命中" : "Cache read"} {t.usage.cached.toLocaleString()} /{" "}
              {t.usage.input.toLocaleString()} tokens
            </small>
          )}
        </div>
      </div>
    </article>
  );
}

export default function AssistantPage() {
  const zh = useI18n().locale === "zh-CN",
    api = getBridge()?.assistant;
  const [view, setView] = useState<AssistantView>(),
    [older, setOlder] = useState<JournalRow<AssistantTurn>[]>([]);
  const [hasOlder, setHasOlder] = useState(true);
  const [compact, setCompact] = useState(false);
  const [railDocked, setRailDocked] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const rail = compact ? drawerOpen : railDocked;
  const setRail = compact ? setDrawerOpen : setRailDocked;
  const pageRoot = useRef<HTMLElement>(null);
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
  const [attention, setAttention] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
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
  const bottom = useRef<HTMLDivElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    stick = useRef(true),
    input = useRef<HTMLTextAreaElement>(null);
  const generation = useRef(0),
    pendingSubmission = useRef<{ id: string; text: string }>();
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
        for (let i = 0; (attention || i < pageCount) && next !== null && !disposed; i++) {
          const data: AssistantSessionPage = await requestCore("assistant.sessions", { skip: next });
          items.push(...data.items);
          next = data.next;
        }
        const pending = await requestCore<Array<{ sessionId: string; kind: string }>>("interaction.list", {
          status: "pending",
        });
        for (const s of items) {
          const p = pending.find((r) => r.sessionId === s.id);
          if (p) s.status = p.kind === "approval" ? "waiting_approval" : "waiting_input";
        }
        if (!disposed) {
          setPage({ items, next });
          setPendingCount(pending.length);
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
  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [
    stream?.text,
    view?.turns.at(-1)?.seq,
    view?.turns.at(-1)?.value.reply,
    view?.turns.at(-1)?.value.receipts.length,
  ]);
  const loadOlder = async () => {
    const first = turns[0];
    if (!api || !first) return;
    try {
      const prev = await api.view(first.seq);
      stick.current = false;
      setOlder((current) => [...prev.turns, ...current, ...(view?.turns ?? [])]);
      setHasOlder(prev.turns.length === 20);
    } catch (e) {
      setError(assistantError(e));
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
  const selectedModel = connections
    .find((c) => c.id === view?.settings.connectionId)
    ?.models?.find((m) => m.id === view?.settings.model);
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
  const hasAttention = page.items.some((s) => activityOf(s).startsWith("waiting")) || pendingCount > 0;
  const suggest = (text: string) => {
    setDraft(text);
    input.current?.focus();
  };
  const actions = [
    {
      Icon: Workflow,
      title: zh ? "分派任务" : "Assign a task",
      detail: zh ? "交给合适的会话" : "Choose a worker session",
      prompt: zh ? "帮我把这个任务分派到合适的会话：" : "Assign this task to the right session: ",
    },
    {
      Icon: Activity,
      title: zh ? "查看进展" : "Check progress",
      detail: zh ? "查看最近的工作" : "Review recent work",
      prompt: zh ? "我的会话最近都在做什么？" : "What are my sessions working on?",
    },
    {
      Icon: BellDot,
      title: zh ? "待我处理" : "Needs my attention",
      detail: zh ? "定位待回复和审批" : "Find replies and approvals",
      prompt: zh ? "哪些会话正在等我回复或审批？" : "Which sessions need a reply or approval?",
    },
  ];
  const activityLabel = zh ? "会话动态" : "Session activity";
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
    />
  );
  return (
    <section ref={pageRoot} className="as-page">
      <header className="as-header">
        <div className="as-header-identity">
          <span className="as-header-logo" aria-hidden>
            <Workflow size={18} strokeWidth={1.8} />
          </span>
          <h1>{zh ? "工作区助手" : "Workspace assistant"}</h1>
        </div>
        <div className="as-header-tools">
          {(!rail || compact) && (
            <button
              className="as-activity-toggle"
              onClick={() => setRail(true)}
              aria-expanded={rail}
              aria-controls={rail ? "assistant-activity" : undefined}
              aria-label={zh ? "显示会话动态" : "Show session activity"}
            >
              <PanelRightOpen size={16} aria-hidden />
              <span>{activityLabel}</span>
            </button>
          )}
          <Link
            className="as-icon"
            to="/settings?section=assistant"
            state={{ returnTo: "/assistant" }}
            aria-label={zh ? "助手设置" : "Assistant settings"}
            title={zh ? "助手设置" : "Assistant settings"}
          >
            <Settings2 size={17} />
          </Link>
        </div>
      </header>
      <div className="as-layout">
        <div className="as-chat" data-empty={!turns.length}>
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
                {turns.map((row) => (
                  <Turn
                    key={row.seq}
                    row={row}
                    zh={zh}
                    stage={view?.stage}
                    liveText={
                      stream?.turnId === row.value.id && view?.stage === "thinking" ? stream.text : undefined
                    }
                    onStop={(id) => void api?.stop(id).catch((e) => setError(assistantError(e)))}
                  />
                ))}
                <div ref={bottom} aria-hidden className="as-thread-end" />
              </div>
            ) : (
              <div className="as-welcome">
                <h2>{zh ? "安排下一步工作" : "What’s next for your workspace?"}</h2>
                {hasAttention && (
                  <button
                    className="as-attention-link"
                    onClick={() => {
                      setAttention(true);
                      setRail(true);
                    }}
                  >
                    <i />
                    {zh ? "有会话待处理" : "Sessions need attention"}
                    <ChevronRight size={13} />
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="as-dock">
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
                <label className="as-input-label" htmlFor="assistant-message">
                  {zh ? "给助手" : "To assistant"}
                </label>
                <textarea
                  id="assistant-message"
                  ref={input}
                  placeholder={zh ? "安排任务，或询问会话进展…" : "Assign work or ask about a session…"}
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
                  <Layers3 size={14} />
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
                <button
                  type="submit"
                  className="as-send"
                  disabled={!ready || !draft.trim() || sending}
                  aria-label={zh ? "发送指令" : "Send request"}
                  title={zh ? "Enter 发送，Shift + Enter 换行" : "Enter to send, Shift + Enter for a new line"}
                >
                  <ArrowUp size={18} />
                </button>
              </div>
            </form>
            {!turns.length && (
              <div className="as-actions">
                {actions.map(({ Icon, title, detail, prompt }) => (
                  <button key={title} title={detail} onClick={() => suggest(prompt)}>
                    <Icon size={15} strokeWidth={1.7} aria-hidden />
                    {title}
                  </button>
                ))}
              </div>
            )}
            {view?.memoryAt && (
              <small className="as-memory">
                {zh ? "助手记忆已自动整理" : "Assistant memory compacted"} ·{" "}
                {new Date(view.memoryAt).toLocaleString()}
              </small>
            )}
          </div>
        </div>
        {compact && drawerOpen ? (
          <ActivityDrawer label={activityLabel} onClose={() => setDrawerOpen(false)}>
            {activityPanel}
          </ActivityDrawer>
        ) : (
          activityPanel
        )}
      </div>
    </section>
  );
}
