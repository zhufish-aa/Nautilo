import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Progressive rendering for long row lists (diffs): mounts a small initial
 * window and grows it as a trailing sentinel scrolls into view, so opening a
 * huge diff never mounts thousands of highlighted rows in one frame.
 *
 * `resetKey` should change when the underlying content changes; the window
 * then collapses back to `initial` and re-grows from the top.
 */
export function useProgressiveRows(total: number, resetKey: unknown, initial = 200, step = 400): {
  limit: number;
  sentinelRef: (node: HTMLElement | null) => void;
  showAll: () => void;
} {
  const [limit, setLimit] = useState(initial);
  const observerRef = useRef<IntersectionObserver | undefined>(undefined);
  const totalRef = useRef(total);
  totalRef.current = total;

  useEffect(() => {
    setLimit(initial);
  }, [resetKey, initial]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  // The callback identity intentionally depends on `resetKey`: React
  // re-attaches it after a reset, and observe() delivers an initial
  // notification, so a sentinel still on screen resumes auto-loading.
  const sentinelRef = useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = undefined;
      if (!node) return;
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setLimit((current) => Math.min(current + step, totalRef.current));
        }
      });
      observer.observe(node);
      observerRef.current = observer;
    },
    [step, resetKey]
  );

  return { limit: Math.min(limit, total), sentinelRef, showAll: useCallback(() => setLimit(totalRef.current), []) };
}
