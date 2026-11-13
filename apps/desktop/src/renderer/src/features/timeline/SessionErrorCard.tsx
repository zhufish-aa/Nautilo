import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, ArrowRight, ChevronRight, Loader2, RotateCcw, Square } from "lucide-react";
import type { TimelineEvent } from "../../lib/types";
import { sessionErrorPresentation } from "../../lib/session-error-presentation";
import { sendWorkbenchMessage } from "../../lib/orchestration-runtime";
import { useSessionsStore } from "../../stores/sessions";
import { useConnectionsStore } from "../../stores/connections";
import { toast } from "../../stores/toast";
import { formatDateTime } from "../../lib/utils";
import "./session-error.css";

function lastAction(events: TimelineEvent[] | undefined): TimelineEvent | undefined {
  for (let at = (events?.length ?? 0) - 1; at >= 0; at -= 1) {
    const event = events![at]!;
    if (event.data.kind === "tool_group") { const found = lastAction(event.data.items); if (found) return found; }
    if (event.data.kind === "error" || (event.data.kind === "message" && event.data.sender !== "system")) return event;
  }
  return undefined;
}

export function SessionErrorCard({ event, locale }: { event: TimelineEvent & { data: { kind: "error" } }; locale: string }): JSX.Element {
  const zh = locale === "zh-CN";
  const sessionConnectionId = useSessionsStore(state => state.sessions.find(session => session.id === event.sessionId)?.connectionId);
  const connectionId = event.data.connectionId ?? sessionConnectionId;
  const connection = useConnectionsStore(state => state.connections.find(item => item.id === connectionId));
  const presentation = sessionErrorPresentation(event.data.code, event.data.message, zh, connection);
  const settingsPath = `/settings?section=${presentation.settings}${connectionId && presentation.settings === "accounts" ? `&connection=${encodeURIComponent(connectionId)}` : ""}`;
  const foreground = useSessionsStore(state => state.foreground[event.sessionId] ?? state.running[event.sessionId]);
  const exists = useSessionsStore(state => state.sessions.some(session => session.id === event.sessionId));
  const latest = useSessionsStore(state => lastAction(state.events[event.sessionId])?.id);
  const [sending, setSending] = useState(false);
  const active = foreground && ["running", "waiting_approval"].includes(foreground.status);
  const canContinue = exists && !event.background && !active && latest === event.id && (event.data.retryable || presentation.stopped);
  const continueTask = async (): Promise<void> => {
    if (!canContinue || sending) return;
    setSending(true);
    try { await sendWorkbenchMessage(event.sessionId, zh ? "继续" : "Continue"); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setSending(false); }
  };
  return <section className="session-error-card" data-stopped={presentation.stopped || undefined} aria-label={presentation.title}>
    <div className="session-error-main">
      <span className="session-error-icon">{presentation.stopped ? <Square size={12}/> : <AlertCircle size={15}/>}</span>
      <div className="session-error-copy"><h4>{presentation.title}</h4><p>{presentation.description}</p></div>
      {presentation.settings ? <Link className="session-error-action" to={settingsPath}>{presentation.loginRequired ? (zh ? "重新登录" : "Sign in again") : (zh ? "检查设置" : "Check settings")}<ArrowRight size={13}/></Link> : canContinue ? <button type="button" className="session-error-action" disabled={sending} onClick={() => void continueTask()}>{sending ? <Loader2 size={13} className="animate-spin"/> : <RotateCcw size={13}/>} {zh ? "继续" : "Continue"}</button> : null}
    </div>
    <details className="session-error-details"><summary><ChevronRight size={12}/><span>{zh ? "查看详情" : "Details"}</span><code>{event.data.code}</code></summary><div><time dateTime={event.timestamp}>{formatDateTime(event.timestamp, locale as "zh-CN" | "en-US")}</time><span>{zh ? event.data.retryable ? "可重试" : "不支持直接重试" : event.data.retryable ? "Retryable" : "Direct retry unavailable"}</span></div><pre>{event.data.message.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")}</pre></details>
  </section>;
}
