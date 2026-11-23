import { useEffect, useState } from "react";
import type { TimelineChanges, TimelineSnapshot } from "@agenthub/schemas";
import { getBridge, requestCore } from "./bridge";
import { applyTimelineChanges, openTimeline, type SessionTimeline } from "./session-timeline";

export function useSessionTimeline(sessionId: string, enabled: boolean) {
  const [state, setState] = useState<{ sessionId: string; timeline?: SessionTimeline; error?: string }>();
  useEffect(() => {
    if (!enabled || !getBridge()) return;
    let cancelled = false;
    async function follow(): Promise<void> {
      let timeline: SessionTimeline | undefined;
      while (!cancelled) {
        try {
          if (!timeline) {
            timeline = openTimeline(await requestCore<TimelineSnapshot>("session.timeline.open", { sessionId }));
            if (!cancelled) setState({ sessionId, timeline });
          } else {
            const page = await requestCore<TimelineChanges>("session.timeline.wait", { sessionId, revision: timeline.revision });
            if (cancelled) return;
            if (page.reset) { timeline = undefined; continue; }
            const next = applyTimelineChanges(timeline, page);
            if (next !== timeline) {
              timeline = next;
              setState({ sessionId, timeline });
            }
          }
        } catch (error) {
          if (cancelled) return;
          setState({ sessionId, timeline, error: String(error) });
          timeline = undefined;
          await new Promise(resolve => window.setTimeout(resolve, 750));
        }
      }
    }
    void follow();
    return () => { cancelled = true; };
  }, [sessionId, enabled]);
  return state?.sessionId === sessionId ? state : undefined;
}
