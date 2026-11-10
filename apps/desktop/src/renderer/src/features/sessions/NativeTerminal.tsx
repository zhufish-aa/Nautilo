import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Moon, RotateCcw, Square, Sun } from "lucide-react";
import type { ITheme, Terminal as Xterm } from "@xterm/xterm";
import type { NativeHistorySync, TerminalMetadata } from "@agenthub/schemas";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import "@xterm/xterm/css/xterm.css";
import "./workspace-panels.css";

const APPEARANCE_KEY = "nautilo.terminal.appearance";
const terminalTheme = (appearance: "dark" | "light"): ITheme => appearance === "dark" ? {
  background: "#17191d", foreground: "#e6e8ed", cursor: "#e6e8ed", cursorAccent: "#17191d", selectionBackground: "#7386a84d",
  black: "#282c34", red: "#ef8080", green: "#9bce96", yellow: "#e8c184", blue: "#8ab4f8", magenta: "#c9a0e5", cyan: "#8bd5d0", white: "#d4d8e1",
  brightBlack: "#868e9e", brightRed: "#ffa0a0", brightGreen: "#b3e3a9", brightYellow: "#f4d6a0", brightBlue: "#a4c8ff", brightMagenta: "#e2bafa", brightCyan: "#a4ebe5", brightWhite: "#f5f6fa"
} : { background: "#ffffff", foreground: "#20242b", cursor: "#20242b", cursorAccent: "#ffffff", selectionBackground: "#7386a838" };

export type TerminalState = "starting" | "ready" | "syncing" | "sync-error" | "exited" | "error";
export function NativeTerminal({ sessionId, kind = "shell", toolbarTarget, tabId, initialTerminal, restoreOnly = false, active = true, autoFocus = true, closeSignal, onReady, onState }: {
  sessionId: string; kind?: "shell" | "harness"; toolbarTarget?: HTMLElement | null;
  tabId?: string; initialTerminal?: TerminalMetadata; restoreOnly?: boolean; active?: boolean; autoFocus?: boolean; closeSignal?: AbortSignal;
  onReady?: (terminal: TerminalMetadata) => void; onState?: (state: TerminalState) => void;
}): JSX.Element {
  const { locale } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const nativeId = useRef<string>();
  const stopped = useRef(false);
  const acceptInput = useRef(true);
  const pollRef = useRef<(retry?: boolean) => Promise<void>>();
  const terminalRef = useRef<Xterm>();
  const fitRef = useRef<() => void>();
  const latest = useRef({ active, autoFocus, closeSignal, onReady, onState, initialTerminal, restoreOnly });
  latest.current = { active, autoFocus, closeSignal, onReady, onState, initialTerminal, restoreOnly };
  const [appearance, setAppearance] = useState<"dark" | "light">(() => {
    try { return window.localStorage.getItem(APPEARANCE_KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
  });
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<TerminalState>("starting");
  const [historySync, setHistorySync] = useState<NativeHistorySync>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = terminalTheme(appearance);
    try { window.localStorage.setItem(APPEARANCE_KEY, appearance); } catch { /* Keep the current theme. */ }
  }, [appearance]);
  useEffect(() => { latest.current.onState?.(state); }, [state]);
  useEffect(() => {
    if (active) { fitRef.current?.(); if (autoFocus) terminalRef.current?.focus(); void pollRef.current?.(); }
  }, [active, autoFocus]);
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let cleanup: (() => void) | undefined;
    setState("starting"); setError(""); setHistorySync(undefined);
    stopped.current = false; acceptInput.current = true;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !container.current) return;
      const terminal = new Terminal({ cursorBlink: true, cursorStyle: "bar", scrollback: 5000, fontSize: 14, lineHeight: 1.22,
        fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Noto Sans SC Variable", monospace', theme: terminalTheme(appearanceRef.current) });
      terminalRef.current = terminal;
      const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(container.current); if (latest.current.active) fit.fit();
      // Escape belongs to native TUI programs, not to the containing drawer.
      terminal.attachCustomKeyEventHandler((event) => { if (event.key === "Escape") event.stopPropagation(); return true; });
      let fitFrame: number | undefined;
      const scheduleFit = (): void => {
        if (fitFrame !== undefined || disposed || !latest.current.active) return;
        fitFrame = window.requestAnimationFrame(() => { fitFrame = undefined; if (!disposed && latest.current.active && container.current?.clientWidth && container.current.clientHeight) fit.fit(); });
      };
      fitRef.current = scheduleFit;
      const observer = new ResizeObserver(scheduleFit); observer.observe(container.current);
      void document.fonts?.ready.then(scheduleFit);
      const inputs: string[] = [];
      let writing = false;
      const flush = async (): Promise<void> => {
        if (writing || !nativeId.current || disposed) return;
        writing = true;
        try { while (inputs.length && !disposed) await requestCore("terminal.write", { terminalId: nativeId.current, data: inputs.shift()! }); }
        catch (error) { if (!disposed) { setState("error"); setError(String(error)); } }
        finally { writing = false; }
      };
      const data = terminal.onData((text) => { if (latest.current.active && acceptInput.current) { inputs.push(text); void flush(); } });
      const resize = terminal.onResize(({ cols, rows }) => { if (nativeId.current && latest.current.active && acceptInput.current) void requestCore("terminal.resize", { terminalId: nativeId.current, cols, rows }).catch(() => {}); });
      cleanup = () => { observer.disconnect(); if (fitFrame !== undefined) window.cancelAnimationFrame(fitFrame); data.dispose(); resize.dispose(); terminalRef.current = undefined; terminal.dispose(); };
      const previous = generation === 0 ? latest.current.initialTerminal : undefined;
      if (!previous && generation === 0 && latest.current.restoreOnly && kind === "harness") throw new Error(locale === "zh-CN" ? "该原生终端已离线，重新连接可打开原生 CLI。" : "This native terminal is offline. Reconnect to open the native CLI.");
      const metadata = previous ?? await requestCore<TerminalMetadata>(kind === "harness" ? "terminal.native" : "terminal.open", { sessionId, tabId, restoreOnly: generation === 0 && latest.current.restoreOnly, cols: terminal.cols, rows: terminal.rows });
      // Closing a tab can finish before its pending open request returns.
      if (latest.current.closeSignal?.aborted) { await requestCore("terminal.close", { terminalId: metadata.id }); return; }
      if (disposed) return;
      nativeId.current = metadata.id; acceptInput.current = !metadata.exited; latest.current.onReady?.(metadata);
      setState("ready"); window.dispatchEvent(new Event("nautilo:terminal-state")); if (latest.current.active && latest.current.autoFocus) terminal.focus(); void flush();
      // The drawer can resize while the native process is still opening.
      if (latest.current.active && !metadata.exited) void requestCore("terminal.resize", { terminalId: metadata.id, cols: terminal.cols, rows: terminal.rows }).catch(() => {});
      let cursor = 0;
      let polling = false; let retryNext = false; let pollAgain = false;
      const poll = async (retrySync = false): Promise<void> => {
        if (disposed || stopped.current || !latest.current.active) return;
        if (polling) { pollAgain = true; retryNext ||= retrySync; return; }
        polling = true; window.clearTimeout(timer);
        try {
          const frame = await requestCore<{ data: string; cursor: number; reset: boolean; exited: boolean; exitCode?: number; historySync?: NativeHistorySync }>("terminal.read", { terminalId: metadata.id, cursor, retrySync });
          if (disposed || stopped.current) return;
          if (frame.reset) terminal.reset();
          cursor = frame.cursor;
          if (frame.data) await new Promise<void>((resolve) => terminal.write(Uint8Array.from(atob(frame.data), (char) => char.charCodeAt(0)), resolve));
          if (!frame.exited) {
            setError(frame.historySync?.error ? (locale === "zh-CN" ? `原生消息暂未同步：${frame.historySync.error}` : `Native messages have not synced: ${frame.historySync.error}`) : "");
          }
          if (frame.exited) {
            acceptInput.current = false; inputs.length = 0; setHistorySync(frame.historySync);
            const phase = frame.historySync?.status;
            window.dispatchEvent(new Event("nautilo:terminal-state"));
            if (phase === "failed") { setState("sync-error"); setError(frame.historySync?.error ?? (locale === "zh-CN" ? "原生历史同步失败" : "Native history sync failed")); return; }
            setError("");
            if (phase && !["none", "synced", "unsupported"].includes(phase)) {
              setState("syncing"); timer = window.setTimeout(() => { void poll(); }, 1000); return;
            }
            setState("exited"); return;
          }
          timer = window.setTimeout(() => { void poll(); }, frame.data ? 16 : 80);
        } catch (error) { if (!disposed && !stopped.current) { setState("error"); setError(String(error)); } }
        finally { polling = false; if (pollAgain && !disposed && !stopped.current && latest.current.active) { const retry = retryNext; retryNext = false; pollAgain = false; void poll(retry); } }
      };
      pollRef.current = poll;
      void poll();
    })().catch(async (error) => {
      if (disposed) return;
      setError(kind === "shell" && generation === 0 && latest.current.restoreOnly && !nativeId.current ? (locale === "zh-CN" ? "该终端已离线，重新连接可打开新终端。" : "This terminal is offline. Reconnect to open a new terminal.") : String(error)); setState("error");
      if (kind === "harness") {
        const status = await requestCore<{ historySync?: NativeHistorySync }>("terminal.status", { sessionId }).catch(() => undefined);
        if (!disposed && status?.historySync && ["failed", "syncing"].includes(status.historySync.status)) {
          acceptInput.current = false;
          const pollStatus = async (retrySync = false): Promise<void> => {
            if (disposed || !latest.current.active) return; window.clearTimeout(timer);
            try {
              const status = await requestCore<{ historySync?: NativeHistorySync }>("terminal.status", { sessionId, retrySync });
              if (disposed) return;
              setHistorySync(status.historySync); window.dispatchEvent(new Event("nautilo:terminal-state"));
              if (status.historySync?.status === "failed") {setState("sync-error");setError(status.historySync.error ?? "");return;}
              setError("");
              if (status.historySync?.status === "syncing") {setState("syncing");timer=window.setTimeout(()=>{void pollStatus();},1000);}
              else setState("exited");
            } catch(error) {if (!disposed) {setState("sync-error");setError(String(error));}}
          };
          pollRef.current = pollStatus; void pollStatus();
        }
      }
    });
    return () => { disposed = true; window.clearTimeout(timer); nativeId.current = undefined; pollRef.current = undefined; fitRef.current = undefined; cleanup?.(); };
  }, [sessionId, kind, tabId, generation]);
  const stop = async (): Promise<void> => {
    stopped.current = true;
    try {
      if (nativeId.current) await requestCore(kind === "shell" && tabId ? "terminal.stop" : "terminal.close", { terminalId: nativeId.current });
      acceptInput.current = false;
    }
    catch (error) { stopped.current = false; throw error; }
    window.dispatchEvent(new Event("nautilo:terminal-state"));
    if (kind === "harness" || tabId) { stopped.current = false; if (kind === "harness") setState("syncing"); await pollRef.current?.(); }
    else setState("exited");
  };
  const retryHistory = async (): Promise<void> => {
    setState("syncing"); setError("");
    if (pollRef.current) { await pollRef.current(true); return; }
    const result = await requestCore<{ historySync?: NativeHistorySync }>("terminal.status", { sessionId, retrySync: true });
    setHistorySync(result.historySync); window.dispatchEvent(new Event("nautilo:terminal-state"));
    if (result.historySync?.status === "failed") { setState("sync-error"); setError(result.historySync.error ?? ""); }
    else if (result.historySync?.status === "syncing") { setState("sync-error"); }
    else setState("exited");
  };
  const controls = <>
    {state === "starting" && <span className="native-terminal-status" role="status" aria-label={locale === "zh-CN" ? "正在连接终端" : "Connecting terminal"}><Loader2 size={14} className="animate-spin" /></span>}
    {state === "syncing" && <span className="native-terminal-status" role="status"><Loader2 size={14} className="animate-spin" />{locale === "zh-CN" ? (historySync?.nativeBusy ? "等待原生任务完成" : "同步历史中") : (historySync?.nativeBusy ? "Waiting for native work" : "Syncing history")}</span>}
    {state === "sync-error" && <span className="native-terminal-status">{locale === "zh-CN" ? "同步待重试" : "Sync needs retry"}</span>}
    {state === "exited" && <span className="native-terminal-status" role="status">{historySync?.status === "synced" ? (locale === "zh-CN" ? `已同步 ${historySync.messageCount ?? 0} 条消息` : `Synced ${historySync.messageCount ?? 0} messages`) : historySync?.status === "unsupported" ? (locale === "zh-CN" ? "已退出 · 此 CLI 不支持历史同步" : "Exited · History sync unavailable") : (locale === "zh-CN" ? "已退出" : "Exited")}</span>}
    <button type="button" className="workspace-panel-icon" aria-label={locale === "zh-CN" ? "切换终端配色" : "Toggle terminal theme"} title={locale === "zh-CN" ? "切换终端配色" : "Toggle terminal theme"} onClick={() => setAppearance(value => value === "dark" ? "light" : "dark")}>
      {appearance === "dark" ? <Sun size={15} aria-hidden /> : <Moon size={15} aria-hidden />}
    </button>
    <button type="button" className="workspace-panel-icon" disabled={state === "syncing"} aria-label={state === "sync-error" ? (locale === "zh-CN" ? "重试历史同步" : "Retry history sync") : (locale === "zh-CN" ? "重新连接终端" : "Reconnect terminal")} title={state === "sync-error" ? (locale === "zh-CN" ? "重试历史同步" : "Retry history sync") : (locale === "zh-CN" ? "重新连接终端" : "Reconnect terminal")} onClick={() => { if (state === "sync-error") void retryHistory().catch(error => { setError(String(error)); setState("sync-error"); }); else setGeneration(value => value + 1); }}><RotateCcw size={15} aria-hidden /></button>
    <button type="button" className="workspace-panel-icon" disabled={!nativeId.current || ["exited", "syncing", "sync-error"].includes(state)} aria-label={locale === "zh-CN" ? "结束终端" : "Stop terminal"} title={locale === "zh-CN" ? "结束终端" : "Stop terminal"} onClick={() => { void stop().catch(error => { setError(String(error)); setState("error"); }); }}><Square size={14} aria-hidden /></button>
  </>;
  return <div className="native-terminal" data-appearance={appearance}>
    {active && (toolbarTarget ? createPortal(controls, toolbarTarget) : toolbarTarget === undefined ? <div className="workspace-panel-toolbar"><div /><div className="workspace-panel-actions">{controls}</div></div> : null)}
    {error && <div role="alert" className="native-terminal-error">{error}</div>}
    <div ref={container} className="native-terminal-surface" />
  </div>;
}
