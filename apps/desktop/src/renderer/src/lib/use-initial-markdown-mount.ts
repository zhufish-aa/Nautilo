import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Bound each initial DOM preparation task. No Markdown node is split and no
 * readable text is deferred: the full raw source remains visible. */
export const INITIAL_MARKDOWN_BATCH = 2;
const PROGRESSIVE_FRAGMENT_THRESHOLD = 4;

/** Prepare a large first formatted snapshot across separate tasks, then reveal
 * without remounting. All source stays visible/selectable/findable, and every
 * formatted node exists before switching. Streaming retains its fast path. */
export function useInitialMarkdownMount(fragments: readonly string[] | undefined, held: boolean): {
  count: number;
  showFormatted: boolean;
  held: boolean;
} {
  const [count, setCount] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const length = fragments?.length ?? 0;
  const progressive = typeof window !== "undefined" && !revealed && length > PROGRESSIVE_FRAGMENT_THRESHOLD;
  const prepared = !progressive || count >= length;
  const showFormatted = fragments !== undefined && (revealed || (prepared && !held));
  const generation = useRef(0);

  useLayoutEffect(() => {
    if (fragments === undefined) { setCount(0); setRevealed(false); }
    else if (showFormatted && !revealed) setRevealed(true);
  }, [fragments, showFormatted, revealed]);

  useEffect(() => {
    if (!progressive || prepared) return;
    const current = ++generation.current;
    // Separate tasks let input run between commits. No animation, long delay,
    // or idle-only work that can postpone completion indefinitely.
    const timer = setTimeout(() => {
      if (current === generation.current) setCount((previous) => Math.min(length, previous + INITIAL_MARKDOWN_BATCH));
    }, 0);
    return () => { generation.current++; clearTimeout(timer); };
  }, [progressive, prepared, count, length]);

  return { count: progressive ? Math.min(count, length) : length, showFormatted, held: Boolean(fragments && prepared && held) };
}
