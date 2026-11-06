import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Moon, RotateCcw, Square, Sun } from "lucide-react";
import type { ITheme, Terminal as Xterm } from "@xterm/xterm";
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

export function NativeTerminal({ sessionId, kind = "shell", toolbarTarget }: { sessionId: string; kind?: "shell" | "harness"; toolbarTarget?: HTMLElement | null }): JSX.Element {
  const { locale } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const nativeId = useRef<string>();
  const stopped = useRef(false);
  const terminalRef = useRef<Xterm>();
  const [appearance, setAppearance] = useState<"dark" | "light">(() => {
    try { return window.localStorage.getItem(APPEARANCE_KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
  });
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<"starting" | "ready" | "exited" | "error">("starting");
  const [error, setError] = useState("");
  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = terminalTheme(appearance);
    try { window.localStorage.setItem(APPEARANCE_KEY, appearance); } catch { /* Keep the current theme. */ }
  }, [appearance]);
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let cleanup: (() => void) | undefined;
    setState("starting"); setError("");
    stopped.current = false;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !container.current) return;
      const terminal = new Terminal({ cursorBlink: true, cursorStyle: "bar", scrollback: 5000, fontSize: 14, lineHeight: 1.22,
        fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Noto Sans SC Variable", monospace', theme: terminalTheme(appearanceRef.current) });
      terminalRef.current = terminal;
      const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(container.current); fit.fit();
      // Escape belongs to native TUI programs, not to the containing drawer.
      terminal.attachCustomKeyEventHandler((event) => { if (event.key === "Escape") event.stopPropagation(); return true; });
      let fitFrame: number | undefined;
      const scheduleFit = (): void => {
        if (fitFrame !== undefined || disposed) return;
        fitFrame = window.requestAnimationFrame(() => { fitFrame = undefined; if (!disposed && container.current?.clientWidth && container.current.clientHeight) fit.fit(); });
      };
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
      const data = terminal.onData((text) => { inputs.push(text); void flush(); });
      const resize = terminal.onResize(({ cols, rows }) => { if (nativeId.current) void requestCore("terminal.resize", { terminalId: nativeId.current, cols, rows }).catch(() => {}); });
      cleanup = () => { observer.disconnect(); if (fitFrame !== undefined) window.cancelAnimationFrame(fitFrame); data.dispose(); resize.dispose(); terminalRef.current = undefined; terminal.dispose(); };
      const metadata = await requestCore<{ id: string }>(kind === "harness" ? "terminal.native" : "terminal.open", { sessionId, cols: terminal.cols, rows: terminal.rows });
      if (disposed) return;
      nativeId.current = metadata.id; setState("ready"); window.dispatchEvent(new Event("nautilo:terminal-state")); terminal.focus(); void flush();
      // The drawer can resize while the native process is still opening.
      void requestCore("terminal.resize", { terminalId: metadata.id, cols: terminal.cols, rows: terminal.rows }).catch(() => {});
      let cursor = 0;
      const poll = async (): Promise<void> => {
        if (disposed || stopped.current) return;
        try {
          const frame = await requestCore<{ data: string; cursor: number; reset: boolean; exited: boolean; exitCode?: number }>("terminal.read", { terminalId: metadata.id, cursor });
          if (disposed || stopped.current) return;
          if (frame.reset) terminal.reset();
          cursor = frame.cursor;
          if (frame.data) await new Promise<void>((resolve) => terminal.write(Uint8Array.from(atob(frame.data), (char) => char.charCodeAt(0)), resolve));
          if (frame.exited) { setState("exited"); window.dispatchEvent(new Event("nautilo:terminal-state")); return; }
          timer = window.setTimeout(() => { void poll(); }, frame.data ? 16 : 80);
        } catch (error) { if (!disposed && !stopped.current) { setState("error"); setError(String(error)); } }
      };
      void poll();
    })().catch((error) => { if (!disposed) { setError(String(error)); setState("error"); } });
    return () => { disposed = true; window.clearTimeout(timer); nativeId.current = undefined; cleanup?.(); };
  }, [sessionId, kind, generation]);
  const stop = async (): Promise<void> => {
    stopped.current = true;
    try { if (nativeId.current) await requestCore("terminal.close", { terminalId: nativeId.current }); }
    catch (error) { stopped.current = false; throw error; }
    window.dispatchEvent(new Event("nautilo:terminal-state"));
    setState("exited");
  };
  const controls = <>
    {state === "starting" && <span className="native-terminal-status" role="status" aria-label={locale === "zh-CN" ? "正在连接终端" : "Connecting terminal"}><Loader2 size={14} className="animate-spin" /></span>}
    {state === "exited" && <span className="native-terminal-status">{locale === "zh-CN" ? "已退出" : "Exited"}</span>}
    <button type="button" className="workspace-panel-icon" aria-label={locale === "zh-CN" ? "切换终端配色" : "Toggle terminal theme"} title={locale === "zh-CN" ? "切换终端配色" : "Toggle terminal theme"} onClick={() => setAppearance(value => value === "dark" ? "light" : "dark")}>
      {appearance === "dark" ? <Sun size={15} aria-hidden /> : <Moon size={15} aria-hidden />}
    </button>
    <button type="button" className="workspace-panel-icon" aria-label={locale === "zh-CN" ? "重新连接终端" : "Reconnect terminal"} title={locale === "zh-CN" ? "重新连接终端" : "Reconnect terminal"} onClick={() => setGeneration(value => value + 1)}><RotateCcw size={15} aria-hidden /></button>
    <button type="button" className="workspace-panel-icon" disabled={!nativeId.current || state === "exited"} aria-label={locale === "zh-CN" ? "结束终端" : "Stop terminal"} title={locale === "zh-CN" ? "结束终端" : "Stop terminal"} onClick={() => { void stop().catch(error => { setError(String(error)); setState("error"); }); }}><Square size={14} aria-hidden /></button>
  </>;
  return <div className="native-terminal" data-appearance={appearance}>
    {toolbarTarget ? createPortal(controls, toolbarTarget) : toolbarTarget === undefined ? <div className="workspace-panel-toolbar"><div /><div className="workspace-panel-actions">{controls}</div></div> : null}
    {error && <div role="alert" className="native-terminal-error">{error}</div>}
    <div ref={container} className="native-terminal-surface" />
  </div>;
}
