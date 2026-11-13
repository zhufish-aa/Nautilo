import { useCallback, useEffect, useRef, useState } from "react";
import type { IpcRequestMap, RemoteStatus } from "@agenthub/schemas";
import { requestCore } from "../../../lib/bridge";

type ManagementMethod = Extract<keyof IpcRequestMap, `remote.${string}`>;
export function useRemoteAccess() {
  const [status, setStatus] = useState<RemoteStatus>();
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const revision = useRef(0);
  const inFlight = useRef(false);
  const mutating = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current || mutating.current) return;
    const version = revision.current;
    inFlight.current = true;
    try {
      const value = await requestCore<RemoteStatus>("remote.status", {});
      if (active.current && version === revision.current) {
        setStatus(value);
        setConnectionError("");
      }
    } catch (cause) {
      if (active.current) setConnectionError(String(cause));
    } finally {
      inFlight.current = false;
    }
  }, []);
  useEffect(() => {
    active.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 2000);
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  const execute = useCallback(
    async <M extends ManagementMethod>(
      method: M,
      input: IpcRequestMap[M]["input"],
    ): Promise<IpcRequestMap[M]["output"] | undefined> => {
      if (mutating.current) return undefined;
      revision.current += 1;
      mutating.current = true;
      setBusy(true);
      setError("");
      try {
        const result = await requestCore<IpcRequestMap[M]["output"]>(
          method,
          input,
        );
        if (active.current) {
          try {
            const value = await requestCore<RemoteStatus>("remote.status", {});
            if (active.current) {
              setStatus(value);
              setConnectionError("");
            }
          } catch (cause) {
            if (active.current) setConnectionError(String(cause));
          }
        }
        return result;
      } catch (cause) {
        if (active.current) setError(String(cause));
        return undefined;
      } finally {
        revision.current += 1;
        mutating.current = false;
        if (active.current) setBusy(false);
      }
    },
    [],
  );
  return { status, error: error || connectionError, busy, refresh, execute };
}
