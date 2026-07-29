import { useSessionsStore } from "../stores/sessions";
import { useInteractionsStore } from "../stores/interactions";
import { useSettingsStore } from "../stores/settings";
import { pendingCountsBySession, shouldNotify, terminalTransition } from "./notification-policy";

/**
 * "跑完了叫我": watches the session/interaction stores and raises a system
 * notification when a turn finishes while the user is elsewhere, or when a
 * provider pauses for an approval/question. Renderer-only — Electron grants
 * Notification permission by default on Windows.
 */

interface NotificationStrings {
  completed: string;
  failed: string;
  cancelled: string;
  waiting: string;
  approval: string;
  untitled: string;
}

const STRINGS: Record<string, NotificationStrings> = {
  "zh-CN": {
    completed: "运行完成",
    failed: "运行失败",
    cancelled: "运行已取消",
    waiting: "等待你处理",
    approval: "有审批或问题需要你处理",
    untitled: "未命名会话"
  },
  "en-US": {
    completed: "Run finished",
    failed: "Run failed",
    cancelled: "Run cancelled",
    waiting: "Needs your input",
    approval: "An approval or question is waiting",
    untitled: "Untitled session"
  }
};

function strings(): NotificationStrings {
  return STRINGS[useSettingsStore.getState().locale] ?? STRINGS["zh-CN"]!;
}

let audioContext: AudioContext | undefined;

/** Two short sine blips; no audio assets needed. */
function chime(): void {
  try {
    audioContext ??= new AudioContext();
    const start = audioContext.currentTime;
    for (const [offset, frequency] of [[0, 880], [0.12, 1174.66]] as const) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.08, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.18);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.2);
    }
  } catch { /* audio is best-effort */ }
}

function notify(sessionId: string, title: string, body: string, withSound: boolean): void {
  const settings = useSettingsStore.getState();
  if (!settings.notificationsEnabled) return;
  if (typeof Notification === "undefined" || Notification.permission === "denied") return;
  const notification = new Notification(title, { body, silent: true });
  if (withSound && settings.notificationSound) chime();
  notification.onclick = () => {
    window.focus();
    useSessionsStore.getState().setActiveSession(sessionId);
    if (!window.location.hash.startsWith("#/sessions")) window.location.hash = "#/sessions";
  };
}

let started = false;

/** Idempotent: safe to call from every bootstrap path. */
export function startNotificationWatcher(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  useSessionsStore.subscribe((state, previous) => {
    for (const [sessionId, next] of Object.entries(state.foreground)) {
      const outcome = terminalTransition(previous.foreground[sessionId], next);
      if (!outcome) continue;
      if (!shouldNotify(sessionId, state.activeSessionId, document.hidden)) continue;
      const text = strings();
      const title = state.sessions.find((session) => session.id === sessionId)?.title || text.untitled;
      notify(sessionId, title, text[outcome], outcome === "failed");
    }
  });

  useInteractionsStore.subscribe((state, previous) => {
    const next = pendingCountsBySession(state.bySession);
    const before = pendingCountsBySession(previous.bySession);
    for (const [sessionId, count] of Object.entries(next)) {
      if (count <= (before[sessionId] ?? 0)) continue;
      if (!shouldNotify(sessionId, useSessionsStore.getState().activeSessionId, document.hidden)) continue;
      const text = strings();
      const title = useSessionsStore.getState().sessions.find((session) => session.id === sessionId)?.title || text.untitled;
      notify(sessionId, `${text.waiting} · ${title}`, text.approval, true);
    }
  });
}
