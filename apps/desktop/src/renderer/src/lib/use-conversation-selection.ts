import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { resolveWorkspaceSession } from "./workspace-state";
import { useSessionsStore } from "../stores/sessions";
import { loadLinkedSession } from "./orchestration-runtime";

/** One selection for both legacy URLs. Persisted mode is deliberately untouched. */
export function useConversationSelection(active: boolean) {
  const location = useLocation();
  const navigate = useNavigate();
  const sessions = useSessionsStore((state) => state.sessions);
  const activeId = useSessionsStore((state) => state.activeSessionId);
  const setActive = useSessionsStore((state) => state.setActiveSession);
  const search = useRef(location.search);
  if (active) search.current = location.search;
  const query = new URLSearchParams(search.current);
  const newConversation = query.get("new") === "1";
  const requestedId = query.get("session");
  const session = resolveWorkspaceSession(sessions, search.current, activeId);
  const unlistedId = !session && !newConversation ? requestedId : null;
  const [lookup, setLookup] = useState<{ id: string; result: "missing" | "error" }>();
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!active || !unlistedId) return;
    let current = true;
    setLookup(undefined);
    void loadLinkedSession(unlistedId).then((found) => {
      if (current && !found) setLookup({ id: unlistedId, result: "missing" });
    }, () => {
      if (current) setLookup({ id: unlistedId, result: "error" });
    });
    return () => { current = false; };
  }, [active, unlistedId, retry]);

  useEffect(() => {
    if (!active) return;
    if (newConversation) {
      if (activeId) setActive(undefined);
    } else if (session && activeId !== session.id) {
      setActive(session.id);
    }
  }, [active, newConversation, activeId, session, setActive]);

  const openSession = useCallback((id: string): void => {
    setActive(id);
    navigate(`/sessions?session=${encodeURIComponent(id)}`);
  }, [navigate, setActive]);
  const result = unlistedId && lookup?.id === unlistedId ? lookup.result : undefined;
  return {
    sessions, session, openSession,
    loadingSession: Boolean(unlistedId && !result),
    missingSession: result === "missing",
    sessionLoadError: result === "error",
    retrySession: () => { setLookup(undefined); setRetry((value) => value + 1); },
  };
}
