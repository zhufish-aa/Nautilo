import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { resolveWorkspaceSession } from "./workspace-state";
import { useSessionsStore } from "../stores/sessions";

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
  return { sessions, session, openSession, missingSession: Boolean(requestedId && !session && !newConversation) };
}
