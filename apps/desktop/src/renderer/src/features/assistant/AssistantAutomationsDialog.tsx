import { useEffect, useState, type FormEvent } from "react";
import { CalendarClock, GitPullRequest, Play } from "lucide-react";
import { Link } from "react-router-dom";
import type { Project, Session } from "@agenthub/domain";
import type { AssistantAutomationAction, AssistantAutomationsView, AssistantBridge, AssistantRoutineInput } from "../../../../shared/workspace-assistant";
import type { AssistantSessionPage } from "@agenthub/schemas";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { assistantError } from "./AssistantSettingsPanel";

export function AssistantAutomationsDialog({ api, close, openTurn, initialDraft }: {
  api: AssistantBridge;
  close: () => void;
  openTurn: (seq: number) => void;
  initialDraft?: { id: string; data: AssistantRoutineInput };
}) {
  const zh = useI18n().locale === "zh-CN";
  const say = (chinese: string, english: string) => zh ? chinese : english;
  const [view, setView] = useState<AssistantAutomationsView>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [adding, setAdding] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [trigger, setTrigger] = useState<"schedule" | "github">("schedule");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<{ id: string; rows: NonNullable<AssistantAutomationsView["history"]> }>();
  const [draft, setDraft] = useState(initialDraft);
  const [draftLabels, setDraftLabels] = useState<{ session: string; project: string }>();
  useEffect(() => {
    const read = () => void api.automations().then(setView).catch(failure => setError(assistantError(failure)));
    read();
    const off = api.onChange(read);
    void requestCore<Project[]>("project.list").then(registered => {
      setProjects(registered);
      setProjectId(registered[0]?.id ?? "");
    }).catch(failure => setError(assistantError(failure)));
    return off;
  }, [api]);

  useEffect(() => {
    if (!draft) return;
    let active = true;
    const { sessionId } = draft.data;
    void requestCore<AssistantSessionPage>("assistant.sessions", { sessionId }).then(snapshot => {
      const session = snapshot.items[0];
      if (!session) throw Error("目标会话已移除。");
      if (active) setDraftLabels({ session: session.title, project: session.project });
    }).catch(failure => { if (active) setError(assistantError(failure)); });
    return () => { active = false; };
  }, [draft]);

  useEffect(() => {
    if (!adding || !projectId) return;
    let active = true;
    setSessions([]);
    void requestCore<Session[]>("session.list", { projectId }).then(items => {
      if (active) setSessions(items.filter(item => item.status !== "archived"));
    }).catch(failure => { if (active) setError(assistantError(failure)); });
    return () => { active = false; };
  }, [adding, projectId]);

  const act = async (action: AssistantAutomationAction) => {
    setBusy(true);
    setError("");
    try {
      const next = await api.automations(action);
      setView(next);
      if (action.type === "history") setHistory({ id: action.id, rows: next.history ?? [] });
      if (action.type === "remove" && history?.id === action.id) setHistory(undefined);
      if (action.type === "save") {
        setAdding(false);
        setDraft(undefined);
      }
    } catch (failure) {
      setError(assistantError(failure));
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const read = (name: string) => String(fields.get(name) ?? "");
    void act({ type: "save", data: {
      title: read("title"), task: read("task"), sessionId: read("session"),
      trigger: trigger === "github" ? { type: "github", repository: read("repository").trim() } :
        { type: "schedule", at: new Date(read("at")).toISOString(), repeat: read("repeat") as "once" | "daily" | "weekly" },
    } });
  };
  const date = (at: number | string) => new Date(at).toLocaleString(zh ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" });

  return <Dialog open onOpenChange={open => { if (!open) close(); }}
    title={say("自动任务与跟进", "Automations and follow-ups")} widthClass="max-w-2xl"
    description={say("按时间或 GitHub 新 PR 向指定会话发送任务，完成后助手会发消息。", "Send tasks to a session on a schedule or for new GitHub PRs, and get a message when they finish.")}>
    <div className="as-automation">
      {draft && <section className="as-automation-draft">
        <h3>{draft.data.title}</h3>
        <dl>
          <dt>{say("触发条件", "Trigger")}</dt>
          <dd>{draft.data.trigger.type === "github" ? draft.data.trigger.repository + say(" 有新 PR 时", " on new PR") :
            date(draft.data.trigger.at) + " · " + ({ once: say("一次", "Once"), daily: say("每天", "Daily"), weekly: say("每周", "Weekly") }[draft.data.trigger.repeat])}</dd>
          <dt>{say("目标会话", "Target session")}</dt><dd>{draftLabels ? draftLabels.project + " / " + draftLabels.session : "…"}</dd>
          <dt>{say("任务", "Task")}</dt><dd>{draft.data.task}</dd>
        </dl>
        <div className="as-automation-actions">
          <Button size="sm" variant="ghost" onClick={() => setDraft(undefined)}>{say("取消", "Cancel")}</Button>
          <Button size="sm" disabled={busy || !draftLabels} onClick={() => void act({ type: "save", data: draft.data, sourceTurnId: draft.id })}>{say("确认启用", "Enable automation")}</Button>
        </div>
      </section>}
      {!adding && !draft && <div className="as-automation-heading">
        <h3>{say("自动任务", "Automations")}</h3>
        <Button size="sm" onClick={() => setAdding(true)}>{say("新建自动任务", "New automation")}</Button>
      </div>}
      {adding && <form className="as-automation-form" onSubmit={save}>
        <label>{say("名称", "Name")}<input name="title" required maxLength={100} placeholder={say("每周代码审查", "Weekly code review")} /></label>
        <label>{say("触发条件", "Trigger")}<select value={trigger} onChange={event => setTrigger(event.target.value as "schedule" | "github")}>
          <option value="schedule">{say("指定时间", "Scheduled time")}</option>
          <option value="github">{say("公开 GitHub 仓库收到新 PR", "New PR in a public GitHub repository")}</option>
        </select></label>
        {trigger === "schedule" ? <>
          <label>{say("首次执行（本机时间）", "First run (local time)")}<input name="at" type="datetime-local" required /></label>
          <label>{say("重复", "Repeat")}<select name="repeat"><option value="once">{say("一次", "Once")}</option><option value="daily">{say("每天", "Daily")}</option><option value="weekly">{say("每周", "Weekly")}</option></select></label>
        </> : <label className="as-automation-wide">{say("GitHub 仓库", "GitHub repository")}<input name="repository" placeholder="owner/repository" required /></label>}
        <label>{say("项目", "Project")}<select value={projectId} onChange={event => { setProjectId(event.target.value); setSessionId(""); }}>
          {!projects.length && <option value="">{say("请先添加项目", "Add a project first")}</option>}
          {projects.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select></label>
        <label>{say("目标会话", "Target session")}<select name="session" required value={sessionId} onChange={event => setSessionId(event.target.value)}>
          <option value="" disabled>{say("选择接收任务的会话", "Choose a session")}</option>
          {sessions.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}
        </select></label>
        <label className="as-automation-wide">{say("发送到会话的消息", "Message to send")}
          <textarea name="task" required rows={3} maxLength={12000} placeholder={say("只审查，重点检查回归和漏测。", "Review for regressions and missing tests.")} />
        </label>
        <div className="as-automation-actions as-automation-wide">
          <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>{say("取消", "Cancel")}</Button>
          <Button size="sm" type="submit" disabled={busy || !sessions.length}>{say("保存自动任务", "Save automation")}</Button>
        </div>
      </form>}
      {!view && !error && <p className="as-automation-empty" role="status">{say("正在加载…", "Loading…")}</p>}
      {view && !adding && !draft && !view.routines.length && <p className="as-automation-empty">{say("还没有自动任务。", "No automations yet.")}</p>}
      {!!view?.routines.length && <ul className="as-automation-list">{view.routines.map(routine => (
        <li key={routine.id}>
          <span className="as-automation-mark">{routine.trigger.type === "schedule" ? <CalendarClock size={17} /> : <GitPullRequest size={17} />}</span>
          <div className="as-automation-copy">
            <strong>{routine.title}</strong>
            <small>{routine.paused ? say("已暂停", "Paused") : routine.trigger.type === "github" ? routine.trigger.repository :
              routine.nextAt === null ? say("已触发", "Triggered") : date(routine.nextAt)}</small>
            {routine.latest && <button className="as-text-button" onClick={() => openTurn(routine.latest!.turnSeq)}>{say("上次运行", "Last run")} · {date(routine.latest.at)}</button>}
            {routine.error && <small className="text-danger">{routine.error}</small>}
          </div>
          <div className="as-automation-actions">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act({ type: "run", id: routine.id })}><Play size={13} />{say("试跑", "Run now")}</Button>
            <Button variant="ghost" size="sm" disabled={busy} aria-expanded={history?.id === routine.id}
              onClick={() => history?.id === routine.id ? setHistory(undefined) : void act({ type: "history", id: routine.id })}>{say("历史", "History")}</Button>
            <Button variant="ghost" size="sm" disabled={busy || routine.nextAt === null} onClick={() => void act({ type: routine.paused ? "resume" : "pause", id: routine.id })}>
              {routine.paused ? say("恢复", "Resume") : say("暂停", "Pause")}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act({ type: "remove", id: routine.id })}>{say("移除", "Remove")}</Button>
          </div>
          {history?.id === routine.id && <div className="as-automation-history">
            {history.rows.length ? history.rows.map(entry => <button key={entry.seq} className="as-text-button" onClick={() => openTurn(entry.seq)}>
              <time>{date(entry.at)}</time><span>{entry.reply}</span>
            </button>) : <small>{say("还没有运行记录。", "No runs yet.")}</small>}
          </div>}
        </li>
      ))}</ul>}
      <div className="as-automation-heading">
        <h3>{say("主动跟进的话题", "Topics being followed")}</h3>
        <Link to="/settings?section=assistant" state={{ returnTo: "/assistant" }}>{say("跟进设置", "Follow-up settings")}</Link>
      </div>
      {view && !view.topics.length && <p className="as-automation-empty">{say("目前没有在跟进的话题。", "No topics being followed.")}</p>}
      {!!view?.topics.length && <ul className="as-automation-list">{view.topics.map(topic => (
        <li key={topic.turnId + topic.topic}>
          <div className="as-automation-copy"><strong>{topic.topic}</strong><small>{date(topic.askedAt)}</small>
            {topic.error && <small className="text-danger">{topic.error}</small>}
          </div>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act({ type: "stopTopic", id: topic.turnId })}>{say("停止跟进", "Stop following")}</Button>
        </li>
      ))}</ul>}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
    </div>
  </Dialog>;
}
