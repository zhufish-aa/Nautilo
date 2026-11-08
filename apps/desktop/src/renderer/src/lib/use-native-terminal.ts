import { useEffect, useState } from "react";
import { requestCore } from "./bridge";
import type { NativeHistorySync } from "@agenthub/schemas";
export interface NativeTerminalState { nativeActive: boolean; terminalId?: string; historySync?: NativeHistorySync }
export function useNativeTerminalStatus(sessionId?: string, active = true): boolean {
  return useNativeTerminalState(sessionId, active).nativeActive;
}
export function useNativeTerminalState(sessionId?: string, active = true): NativeTerminalState {
  const [owned, setOwned] = useState<NativeTerminalState & { sessionId?: string }>({ nativeActive: false });
  useEffect(() => {
    if (!sessionId || !active) return;
    let disposed = false; let timer: number | undefined;
    let inFlight = false;
    const poll = async (): Promise<void> => {
      if (inFlight || disposed) return;
      inFlight = true;
      try {
        const state = await requestCore<NativeTerminalState>("terminal.status", { sessionId });
        if (!disposed) { setOwned({ ...state, sessionId }); window.clearTimeout(timer); timer = window.setTimeout(() => { void poll(); }, state.nativeActive ? 1200 : 5000); }
      } catch { if (!disposed) timer = window.setTimeout(() => { void poll(); }, 2000); }
      finally { inFlight = false; }
    };
    const changed = (): void => { void poll(); };
    void poll(); window.addEventListener("nautilo:terminal-state", changed);
    return () => { disposed = true; window.clearTimeout(timer); window.removeEventListener("nautilo:terminal-state", changed); };
  }, [sessionId, active]);
  return owned.sessionId === sessionId ? owned : { nativeActive: false };
}
