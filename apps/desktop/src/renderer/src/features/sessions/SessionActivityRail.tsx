import * as Tooltip from "@radix-ui/react-tooltip";
import { ChartNoAxesColumn, FileDiff, GitBranch, GitFork, Globe, ListChecks, SquareTerminal, Users, Workflow, Wrench } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { IpcRequestMap } from "@agenthub/schemas";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { useContextUsage } from "./ContextUsageIndicator";
import { sourceControlClient } from "./source-control-client";
import "./session-activity-rail.css";

const sessionTools = [
  { id: "inspector", icon: ChartNoAxesColumn, key: "C" },
  { id: "artifacts", label: "sessions.workspace.files", icon: FileDiff, key: "D" },
  { id: "workflow", label: "nav.workflows", icon: Workflow, key: "W" },
  { id: "agents", label: "sessions.workspace.agents", icon: Users, key: "A" },
  { id: "tools", icon: Wrench, key: "M", alternate: "I" }
] as const;

const workspaceTools = [
  { id: "source-control", label: "sessions.workspace.git", icon: GitBranch, key: "G" },
  { id: "terminal", label: "sessions.workspace.terminal", icon: SquareTerminal, key: "T" },
  { id: "browser", label: "sessions.workspace.browser", icon: Globe, key: "B" }
] as const;

const optionalTools = [
  { id: "goals", label: "sessions.workspace.goals", icon: ListChecks, key: "L" },
  { id: "dag", label: "sessions.header.dag", icon: GitFork, key: "P" }
] as const;

const entries = [...sessionTools, ...workspaceTools, ...optionalTools];
type Entry = typeof entries[number];
type Actions = Partial<Record<Entry["id"], { run(): void; checked: boolean }>>;

export function SessionActivityRail({ actions, sessionId, projectId, fileCount, nativeTerminal, terminalTabs, runningAgents, openFolder }: {
  actions: Actions; sessionId: string; projectId: string; fileCount: number;
  nativeTerminal: boolean; terminalTabs: boolean; runningAgents: boolean; openFolder?: () => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const { percentage } = useContextUsage(sessionId);
  const [gitDirty, setGitDirty] = useState(false);
  const [shellRunning, setShellRunning] = useState(false);
  const hasGit = Boolean(actions["source-control"]);
  const rail = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const handlers = useRef({ actions, openFolder });
  handlers.current = { actions, openFolder };
  const selected = entries.find(entry => actions[entry.id]?.checked)?.id;
  const visible = entries.filter(entry => actions[entry.id]).map(entry => entry.id).join(" ");

  useEffect(() => {
    const scope = { sessionId, projectId };
    let disposed = false;
    let lastGitRead = 0;
    const refreshGit = (): void => {
      if (!hasGit || document.hidden) return;
      lastGitRead = Date.now();
      void sourceControlClient.status(scope).then(status => {
        if (!disposed) setGitDirty(status.available && status.changes.length > 0);
      }, () => { if (!disposed) setGitDirty(false); });
    };
    let readingTerminals = false;
    const refreshTerminals = (): void => {
      if (!terminalTabs || document.hidden || readingTerminals) return;
      readingTerminals = true;
      void requestCore<IpcRequestMap["terminal.list"]["output"]>("terminal.list", { sessionId }).then(({ items }) => {
        if (!disposed) setShellRunning(items.some(item => !item.exited));
      }, () => { if (!disposed) setShellRunning(false); }).finally(() => { readingTerminals = false; });
    };
    const refresh = (): void => { refreshGit(); refreshTerminals(); };
    refresh();
    const timer = window.setInterval(() => {
      if (!document.hasFocus()) return;
      if (Date.now() - lastGitRead >= 30_000) refreshGit();
      refreshTerminals();
    }, 10_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("nautilo:source-control-changed", refreshGit);
    window.addEventListener("nautilo:terminal-state", refreshTerminals);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("nautilo:source-control-changed", refreshGit);
      window.removeEventListener("nautilo:terminal-state", refreshTerminals);
    };
  }, [hasGit, terminalTabs, sessionId, projectId]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      const key = event.key.toUpperCase();
      const entry = entries.find(item => item.key === key || ("alternate" in item && item.alternate === key));
      const action = entry && handlers.current.actions[entry.id];
      if (entry && action) {
        event.preventDefault();
        rail.current?.querySelector<HTMLButtonElement>(`[data-activity="${entry.id}"]`)?.focus({ preventScroll: true });
        action.run();
      } else if (key === "F" && handlers.current.openFolder) {
        event.preventDefault();
        handlers.current.openFolder();
      }
    };
    document.addEventListener("keydown", onShortcut);
    return () => document.removeEventListener("keydown", onShortcut);
  }, []);

  useLayoutEffect(() => {
    const track = rail.current;
    const indicator = marker.current;
    const button = selected && track?.querySelector<HTMLButtonElement>(`[data-activity="${selected}"]`);
    if (!track || !indicator || !button) return;
    const rect = button.getBoundingClientRect();
    const top = rect.top - track.getBoundingClientRect().top + (rect.height - 18) / 2;
    indicator.style.transform = `translateY(${top}px)`;
  }, [selected, visible]);

  function renderTool(entry: Entry): JSX.Element | null {
    const action = actions[entry.id];
    if (!action) return null;
    const { icon: Icon, key, id } = entry;
    const label = "label" in entry ? t(entry.label) : id === "inspector"
      ? (zh ? "会话检查器" : "Conversation inspector") : (zh ? "本次会话工具" : "Session tools");
    const count = id === "artifacts" && fileCount > 0 ? fileCount : undefined;
    const status = id === "source-control" && gitDirty ? "dirty" : id === "terminal" && (nativeTerminal || terminalTabs && shellRunning)
      ? "terminal" : id === "agents" && runningAgents ? "agents" : undefined;
    return <Tooltip.Root key={id}>
      <Tooltip.Trigger asChild>
        <button type="button" className="session-activity-button" data-activity={id} aria-pressed={action.checked}
          aria-label={label} aria-keyshortcuts={"alternate" in entry ? `${key} ${entry.alternate}` : key} onClick={action.run}>
          <Icon size={17} aria-hidden />
          {count !== undefined && <span className="session-activity-count" aria-hidden>{count > 99 ? "99+" : count}</span>}
          {status && <span className="session-activity-dot" data-status={status} aria-hidden />}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="session-activity-tooltip" side="left" sideOffset={9} collisionPadding={8}>
          <span>{label}{count !== undefined ? ` · ${count}` : id === "inspector" && percentage !== undefined ? ` · ${Math.round(percentage)}%` : ""}</span><kbd>{key}</kbd>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>;
  }

  return <Tooltip.Provider delayDuration={180} skipDelayDuration={0}><nav className="session-activity-rail" aria-label={t("sessions.workspace.title")}>
    <div className="session-activity-track" ref={rail}>
      <span className="session-activity-marker" ref={marker} data-visible={Boolean(selected)} aria-hidden />
      <div role="group" aria-label={t("sessions.workspace.session")}>{sessionTools.map(renderTool)}</div>
      <div role="separator" className="session-activity-divider" />
      <div role="group" aria-label={t("sessions.workspace.tools")}>{workspaceTools.map(renderTool)}</div>
      {optionalTools.some(entry => actions[entry.id]) && <div className="session-activity-secondary" role="group" aria-label={zh ? "会话辅助工具" : "Additional conversation tools"}>{optionalTools.map(renderTool)}</div>}
    </div>
  </nav></Tooltip.Provider>;
}
