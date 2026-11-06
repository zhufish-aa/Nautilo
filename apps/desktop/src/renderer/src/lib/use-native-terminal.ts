import { useEffect, useState } from "react";
import { requestCore } from "./bridge";
export function useNativeTerminalStatus(sessionId?: string, active = true): boolean {
  const [owned, setOwned] = useState(false);
  useEffect(() => {
    if (!sessionId || !active) return;
    let disposed = false; let timer: number | undefined;
    let inFlight = false;
    const poll = async (): Promise<void> => {
      if (inFlight || disposed) return;
      inFlight = true;
      try {
        const state = await requestCore<{ nativeActive: boolean }>("terminal.status", { sessionId });
        if (!disposed) { setOwned(state.nativeActive); window.clearTimeout(timer); timer = window.setTimeout(() => { void poll(); }, state.nativeActive ? 1200 : 5000); }
      } catch { /* Older daemons keep normal chat available. */ }
      finally { inFlight = false; }
    };
    const changed = (): void => { void poll(); };
    setOwned(false); void poll(); window.addEventListener("nautilo:terminal-state", changed);
    return () => { disposed = true; window.clearTimeout(timer); window.removeEventListener("nautilo:terminal-state", changed); };
  }, [sessionId, active]);
  return owned;
}
