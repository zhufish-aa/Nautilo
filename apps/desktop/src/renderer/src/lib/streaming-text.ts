import { useEffect, useRef, useState } from "react";

/** Full Markdown parsing grows with the cumulative answer. Keep short replies
 * responsive, but coalesce large in-flight snapshots rather than reparsing a
 * tens-of-KB document 20 times a second. Never retain intermediate snapshots. */
export function streamingTextDelay(length: number): number {
  return Math.min(500, Math.max(50, Math.ceil(length / 8_000) * 50));
}

export function useStreamingText(text: string, streaming: boolean, identity?: string): string {
  // A new message and its first non-empty output bypass coalescing entirely.
  const [visible, setVisible] = useState({ text, identity });
  const latest = useRef({ text, identity });
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pendingDelay = useRef(0);
  latest.current = { text, identity };
  const immediate = !streaming || visible.identity !== identity || (!visible.text && Boolean(text));
  useEffect(() => {
    const delay = streamingTextDelay(text.length);
    if (immediate) {
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = undefined;
      pendingDelay.current = 0;
      setVisible({ text, identity });
    } else {
      // A shorter replacement should regain the short-message cadence rather
      // than inherit the previous large snapshot's half-second timer.
      if (timer.current !== undefined && delay < pendingDelay.current) {
        clearTimeout(timer.current);
        timer.current = undefined;
      }
      if (timer.current === undefined) {
        pendingDelay.current = delay;
        timer.current = setTimeout(() => {
          timer.current = undefined;
          pendingDelay.current = 0;
          setVisible(latest.current);
        }, delay);
      }
    }
  }, [text, streaming, identity]);
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current); }, []);
  return immediate ? text : visible.text;
}
