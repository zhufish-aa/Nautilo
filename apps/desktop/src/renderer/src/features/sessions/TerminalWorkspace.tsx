import { useEffect, useId, useRef, useState } from "react";
import { FileText, Loader2, Plus, SquareTerminal, TerminalSquare, X } from "lucide-react";
import type { TerminalMetadata } from "@agenthub/schemas";
import type { NativeRuntimeCapabilities } from "@agenthub/provider-sdk";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { terminalWindowStart } from "../../lib/terminal-window";
import { useNativeTerminalState } from "../../lib/use-native-terminal";
import { useSessionsStore, SESSION_EMPTY } from "../../stores/sessions";
import { toast } from "../../stores/toast";
import { NativeTerminal, type TerminalState } from "./NativeTerminal";
import { WorkspaceDrawer } from "./WorkspaceDrawer";

interface ShellTab { id: string; ordinal: number; title?: string; fresh: boolean; terminal?: TerminalMetadata; state?: TerminalState }
interface Layout { tabs: ShellTab[]; active: string; nextOrdinal: number; nativeOpened: boolean }
const storageKey = (sessionId: string) => `nautilo.terminal.tabs.v1.${sessionId}`;
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(id) && id !== "native" && id !== "logs";
function readLayout(sessionId?: string): Layout {
  const fallback: Layout = { tabs: sessionId ? [{ id: "default", ordinal: 1, fresh: true }] : [], active: sessionId ? "default" : "logs", nextOrdinal: 2, nativeOpened: false };
  if (!sessionId) return fallback;
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey(sessionId)) ?? "null");
    if (saved?.version !== 1 || !Array.isArray(saved.tabs)) return fallback;
    const ids = new Set<string>();
    const tabs: ShellTab[] = saved.tabs.filter((tab: ShellTab) => tab && validId(tab.id) && !ids.has(tab.id) && !!ids.add(tab.id)).slice(0, 64).map((tab: ShellTab, index: number) => ({
      id: tab.id, ordinal: Number.isSafeInteger(tab.ordinal) && tab.ordinal > 0 ? tab.ordinal : index + 1,
      title: typeof tab.title === "string" ? tab.title.trim().slice(0, 80) || undefined : undefined, fresh: (tab as ShellTab & { launched?: boolean }).launched === false
    }));
    const active = saved.active === "logs" || saved.active === "native" && saved.nativeOpened || tabs.some(tab => tab.id === saved.active) ? saved.active : tabs[0]?.id ?? "logs";
    const nextOrdinal = Math.max(2, ...tabs.map(tab => tab.ordinal + 1), Number.isSafeInteger(saved.nextOrdinal) && saved.nextOrdinal > 0 ? saved.nextOrdinal : 2);
    return { tabs, active, nextOrdinal, nativeOpened: saved.nativeOpened === true };
  } catch { return fallback; }
}

/** A session change detaches the screen; only explicitly closing a tab ends its PTY. */
export function TerminalDrawer(props: { open: boolean; onClose: () => void; sessionId?: string }): JSX.Element | null {
  const opened = useRef(false);
  if (props.open) opened.current = true;
  return opened.current ? <TerminalWorkspace key={props.sessionId ?? "none"} {...props} /> : null;
}

function TerminalWorkspace({ open, onClose, sessionId }: { open: boolean; onClose: () => void; sessionId?: string }): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const prefix = useId();
  const [layout, setLayout] = useState(() => readLayout(sessionId));
  const [loaded, setLoaded] = useState(!sessionId);
  const [loadError, setLoadError] = useState("");
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [nativeTerminal, setNativeTerminal] = useState<TerminalMetadata>();
  const [nativeVersion, setNativeVersion] = useState(0);
  const nativeIdentity = useRef<string>();
  const autoSelectNative = useRef(true);
  const [nativeFresh, setNativeFresh] = useState(false);
  const [visited, setVisited] = useState(() => new Set<string>());
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [closing, setClosing] = useState<Set<string>>(() => new Set());
  const closed = useRef(new Set<string>());
  const signals = useRef(new Map<string, AbortController>());
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState("");
  const [focusTerminal, setFocusTerminal] = useState(true);
  const tabsRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const [lineLimit, setLineLimit] = useState(500);
  const lines = useSessionsStore(state => sessionId ? state.rawLog[sessionId] ?? SESSION_EMPTY.lines : SESSION_EMPTY.lines);
  const native = useNativeTerminalState(sessionId, open);
  const nativeVisible = nativeAvailable || native.nativeActive || layout.nativeOpened;
  const title = (tab: ShellTab): string => tab.title ?? `${zh ? "终端" : "Terminal"} ${tab.ordinal}`;
  const signal = (id: string): AbortSignal => {
    if (!signals.current.has(id)) signals.current.set(id, new AbortController());
    return signals.current.get(id)!.signal;
  };
  useEffect(() => { if (!open) autoSelectNative.current = true; }, [open]);
  useEffect(() => {
    if (!sessionId) return;
    try { window.localStorage.setItem(storageKey(sessionId), JSON.stringify({ version: 1, active: layout.active, nextOrdinal: layout.nextOrdinal, nativeOpened: layout.nativeOpened, tabs: layout.tabs.map(({ id, ordinal, title, fresh }) => ({ id, ordinal, title, launched: !fresh })) })); } catch { /* Keep the in-memory layout. */ }
  }, [layout, sessionId]);
  useEffect(() => {
    if (!open || !sessionId) return;
    let disposed = false;
    void requestCore<NativeRuntimeCapabilities>("agent.runtimeCapabilities", { sessionId }).then(capabilities => { if (!disposed) setNativeAvailable(capabilities.interactions.nativeTerminal); }).catch(() => {});
    void requestCore<{ items: TerminalMetadata[] }>("terminal.list", { sessionId }).then(({ items }) => {
      if (disposed) return;
      setLoadError("");
      const shells = items.filter(item => item.kind === "shell" && validId(item.tabId) && !closed.current.has(item.tabId));
      setLayout(previous => {
        let nextOrdinal = previous.nextOrdinal;
        const tabs = previous.tabs.map(tab => { const terminal = shells.find(item => item.tabId === tab.id) ?? tab.terminal; return { ...tab, terminal, fresh: terminal ? false : tab.fresh }; });
        for (const terminal of shells) if (!tabs.some(tab => tab.id === terminal.tabId)) tabs.push({ id: terminal.tabId!, ordinal: nextOrdinal++, fresh: false, terminal });
        return { ...previous, tabs, nextOrdinal };
      });
      const restored = items.find(item => item.kind === "harness");
      if (restored && !nativeIdentity.current) { nativeIdentity.current = restored.id; setNativeTerminal(restored); }
    }).catch(error => { if (!disposed) setLoadError(String(error)); }).finally(() => { if (!disposed) setLoaded(true); });
    return () => { disposed = true; };
  }, [open, sessionId]);
  useEffect(() => {
    if (!open || !native.nativeActive || !native.terminalId) return;
    const external = nativeIdentity.current !== native.terminalId;
    if (external) {
      nativeIdentity.current = native.terminalId;
      setNativeTerminal({ id: native.terminalId, cwd: "", kind: "harness" });
      setNativeVersion(value => value + 1);
    }
    setNativeFresh(false);
    if (external || autoSelectNative.current) setLayout(previous => ({ ...previous, active: "native", nativeOpened: true }));
    autoSelectNative.current = false;
  }, [open, native.nativeActive, native.terminalId]);
  useEffect(() => {
    if (open && loaded && layout.active !== "logs") setVisited(previous => previous.has(layout.active) ? previous : new Set(previous).add(layout.active));
  }, [open, loaded, layout.active]);
  useEffect(() => {
    if (open && layout.active === "logs" && followOutput.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [open, layout.active, lines.length]);

  const select = (id: string, focus = true): void => {
    setFocusTerminal(focus);
    autoSelectNative.current = false;
    if (id === "native" && !layout.nativeOpened) setNativeFresh(true);
    setLayout(previous => ({ ...previous, active: id, nativeOpened: previous.nativeOpened || id === "native" }));
  };
  const add = (): void => {
    if (!sessionId || layout.tabs.length >= 32) return;
    autoSelectNative.current = false;
    setFocusTerminal(true);
    const id = `shell_${crypto.randomUUID()}`;
    setLayout(previous => ({ ...previous, tabs: [...previous.tabs, { id, ordinal: previous.nextOrdinal, fresh: true }], active: id, nextOrdinal: previous.nextOrdinal + 1 }));
  };
  const closeTab = async (id: string): Promise<void> => {
    if (!sessionId || closing.has(id)) return;
    signal(id);
    signals.current.get(id)!.abort();
    setClosing(previous => new Set(previous).add(id));
    closed.current.add(id);
    try {
      await requestCore("terminal.close", { sessionId, tabId: id });
      setLayout(previous => {
        const index = previous.tabs.findIndex(tab => tab.id === id), tabs = previous.tabs.filter(tab => tab.id !== id);
        return { ...previous, tabs, active: previous.active === id ? tabs[Math.min(index, tabs.length - 1)]?.id ?? "logs" : previous.active };
      });
      setVisited(previous => { const next = new Set(previous); next.delete(id); return next; });
      signals.current.delete(id);
    } catch (error) { closed.current.delete(id); signals.current.set(id, new AbortController()); toast.error(String(error)); }
    finally { setClosing(previous => { const next = new Set(previous); next.delete(id); return next; }); }
  };
  const rename = (): void => {
    if (editing) setLayout(previous => ({ ...previous, tabs: previous.tabs.map(tab => tab.id === editing ? { ...tab, title: draft.trim().slice(0, 80) || undefined } : tab) }));
    setEditing(undefined);
  };
  const focusTab = (id: string): void => {
    const find = () => tabsRef.current?.querySelector<HTMLButtonElement>(`[role="tab"][data-tab-id="${id}"]`);
    const target = find(); if (target) target.focus(); else window.requestAnimationFrame(() => find()?.focus());
  };
  const startLine = terminalWindowStart(lines.length, lineLimit);
  return <div className="contents" onKeyDownCapture={event => {
    if (event.ctrlKey && event.shiftKey && !event.altKey && (event.key.toLowerCase() === "t" || event.key.toLowerCase() === "w")) {
      event.preventDefault(); event.stopPropagation();
      if (event.key.toLowerCase() === "t") add(); else if (layout.tabs.some(tab => tab.id === layout.active)) void closeTab(layout.active);
    }
  }}>
    <WorkspaceDrawer placement="bottom" open={open} keepMounted onClose={onClose} title={zh ? "终端" : "Terminal"} resizable defaultHeight={320} storageKey="nautilo.terminal.height"
      headerContent={<div className="terminal-tab-strip">
        <div ref={tabsRef} className="terminal-tabs" role="tablist" aria-label={zh ? "终端视图" : "Terminal views"} onKeyDown={event => {
          if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab") return;
          const focusedId = event.target.dataset.tabId ?? layout.active;
          const ids = [...layout.tabs.map(tab => tab.id), ...(nativeVisible ? ["native"] : []), "logs"], index = ids.indexOf(focusedId);
          const next = event.key === "ArrowRight" ? ids[(index + 1) % ids.length] : event.key === "ArrowLeft" ? ids[(index + ids.length - 1) % ids.length] : event.key === "Home" ? ids[0] : event.key === "End" ? ids.at(-1) : undefined;
          if (next) { event.preventDefault(); select(next, false); focusTab(next); }
          if (event.key === "F2") { const tab = layout.tabs.find(tab => tab.id === focusedId); if (tab) { event.preventDefault(); setFocusTerminal(false); setDraft(title(tab)); setEditing(tab.id); } }
        }}>
          {layout.tabs.map(tab => <div className="terminal-tab-entry" data-selected={layout.active === tab.id} key={tab.id}>
            {editing === tab.id ? <input className="terminal-tab-name" aria-label={zh ? "终端名称" : "Terminal name"} value={draft} autoFocus maxLength={80} onChange={event => setDraft(event.target.value)} onBlur={rename} onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter") { event.preventDefault(); rename(); focusTab(tab.id); } else if (event.key === "Escape") { event.preventDefault(); setEditing(undefined); focusTab(tab.id); } }} /> :
              <button type="button" className="terminal-tab" role="tab" id={`${prefix}-tab-${tab.id}`} data-tab-id={tab.id} aria-controls={`${prefix}-pane-${tab.id}`} aria-selected={layout.active === tab.id} tabIndex={layout.active === tab.id ? 0 : -1} title={zh ? `${title(tab)} · 双击重命名` : `${title(tab)} · Double-click to rename`} onClick={() => select(tab.id)} onDoubleClick={() => { setFocusTerminal(false); setDraft(title(tab)); setEditing(tab.id); }}><SquareTerminal size={14} aria-hidden /><span className="terminal-tab-label">{title(tab)}</span>{["exited", "error"].includes(tab.state ?? "") && <span className="terminal-tab-dot" data-state={tab.state} aria-label={tab.state === "exited" ? (zh ? "已退出" : "Exited") : (zh ? "已离线" : "Offline")} />}</button>}
            <button type="button" className="terminal-tab-close" disabled={closing.has(tab.id)} aria-label={zh ? `关闭${title(tab)}` : `Close ${title(tab)}`} title={zh ? "关闭此终端" : "Close this terminal"} onClick={() => { void closeTab(tab.id); }}>{closing.has(tab.id) ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}</button>
          </div>)}
          {nativeVisible && <button type="button" className="terminal-tab" role="tab" id={`${prefix}-tab-native`} data-tab-id="native" aria-controls={`${prefix}-pane-native`} aria-selected={layout.active === "native"} tabIndex={layout.active === "native" ? 0 : -1} onClick={() => select("native")}><TerminalSquare size={14} aria-hidden />{zh ? "原生 CLI" : "Native CLI"}</button>}
          <button type="button" className="terminal-tab" role="tab" id={`${prefix}-tab-logs`} data-tab-id="logs" aria-controls={`${prefix}-pane-logs`} aria-selected={layout.active === "logs"} tabIndex={layout.active === "logs" ? 0 : -1} onClick={() => select("logs")}><FileText size={14} aria-hidden />{zh ? "运行日志" : "Logs"}</button>
        </div>
        {sessionId && <button type="button" className="workspace-panel-icon" disabled={layout.tabs.length >= 32} aria-label={zh ? "新建终端" : "New terminal"} title={zh ? "新建终端 (Ctrl+Shift+T)" : "New terminal (Ctrl+Shift+T)"} onClick={add}><Plus size={16} /></button>}
      </div>}
      headerActions={<div ref={setToolbarTarget} className="workspace-panel-actions" />}>
      {loadError && <div role="alert" className="terminal-workspace-error">{zh ? "终端列表暂未恢复：" : "Could not restore terminals: "}{loadError}</div>}
      {!loaded && <div className="terminal-workspace-loading" role="status"><Loader2 size={16} className="animate-spin" />{zh ? "正在恢复终端" : "Restoring terminals"}</div>}
      {sessionId && loaded && layout.tabs.map(tab => visited.has(tab.id) && <div key={tab.id} role="tabpanel" className="terminal-pane" id={`${prefix}-pane-${tab.id}`} aria-labelledby={`${prefix}-tab-${tab.id}`} hidden={layout.active !== tab.id}>
        <NativeTerminal sessionId={sessionId} tabId={tab.id} initialTerminal={tab.terminal} restoreOnly={!tab.fresh} closeSignal={signal(tab.id)} active={open && layout.active === tab.id} autoFocus={focusTerminal} toolbarTarget={toolbarTarget}
          onReady={terminal => setLayout(previous => ({ ...previous, tabs: previous.tabs.map(item => item.id === tab.id ? { ...item, terminal, fresh: false } : item) }))}
          onState={state => setLayout(previous => previous.tabs.find(item => item.id === tab.id)?.state === state ? previous : { ...previous, tabs: previous.tabs.map(item => item.id === tab.id ? { ...item, state } : item) })} />
      </div>)}
      {sessionId && loaded && visited.has("native") && <div role="tabpanel" className="terminal-pane" id={`${prefix}-pane-native`} aria-labelledby={`${prefix}-tab-native`} hidden={layout.active !== "native"}>
        <NativeTerminal key={nativeVersion} sessionId={sessionId} kind="harness" initialTerminal={nativeTerminal} restoreOnly={!nativeFresh} active={open && layout.active === "native"} autoFocus={focusTerminal} toolbarTarget={toolbarTarget} onReady={terminal => { nativeIdentity.current = terminal.id; setNativeTerminal(terminal); setNativeFresh(false); }} />
      </div>}
      <div role="tabpanel" id={`${prefix}-pane-logs`} aria-labelledby={`${prefix}-tab-logs`} hidden={layout.active !== "logs"} className="terminal-log-pane h-full overflow-y-auto bg-canvas px-5 py-4" onScroll={event => { const node = event.currentTarget; followOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; }}>
        {startLine > 0 && <button type="button" className="mb-3 rounded px-2 py-1 text-xs text-ink-3 hover:bg-card-hover" onClick={() => setLineLimit(limit => limit + 500)}>{t("sessions.interactions.showMore")} ({startLine})</button>}
        {lines.length === 0 ? <div className="flex h-40 flex-col items-center justify-center gap-2 text-ink-3"><TerminalSquare className="h-6 w-6" aria-hidden /><p className="text-xs">{t("sessions.drawers.terminalEmpty")}</p></div> : <pre className="font-mono text-[13px] leading-6 whitespace-pre-wrap">{lines.slice(startLine).map((line, index) => <div key={startLine + index} className={line.startsWith("$ ") ? "mt-2 text-ink" : "text-ink-2"}>{line}</div>)}<div ref={bottomRef} /></pre>}
      </div>
    </WorkspaceDrawer>
  </div>;
}
