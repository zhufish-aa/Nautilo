import { useEffect, useMemo, useRef, useState } from "react";
import MarkdownWorker from "./markdown.worker?worker";
import { parseMarkdownFragments } from "./markdown-parse";
import { MarkdownWorkerQueue } from "./markdown-worker-queue";

export const ASYNC_MARKDOWN_THRESHOLD = 8_000;
let sharedQueue: MarkdownWorkerQueue | undefined;

function getQueue(): MarkdownWorkerQueue {
  if (!sharedQueue) sharedQueue = new MarkdownWorkerQueue(new MarkdownWorker(), () => { sharedQueue = undefined; }, () => new MarkdownWorker());
  return sharedQueue;
}

/** Only parser work moves off-thread. All text remains available, and every
 * accepted snapshot is parsed as a complete document. Completion/cancellation
 * submits the newest source without dropping it or waiting for another token. */
export function useMarkdownFragments(source: string): { fragments: string[] | undefined; pending: boolean; unformatted: string } {
  const [parsed, setParsed] = useState<{ source: string; fragments: string[] }>();
  const [failed, setFailed] = useState(false);
  const latestSource = useRef(source);
  latestSource.current = source;
  const asynchronous = !failed && source.length >= ASYNC_MARKDOWN_THRESHOLD && typeof Worker !== "undefined";
  const synchronous = useMemo(() => asynchronous ? undefined : parseMarkdownFragments(source), [source, asynchronous]);
  const subscription = useRef<ReturnType<MarkdownWorkerQueue["subscribe"]>>();
  // A previously parsed short prefix remains visible during the transition to
  // the worker path, with the same fragment keys/components and focus state.
  const previous = useRef<{ source: string; fragments: string[] }>();
  if (synchronous) previous.current = { source, fragments: synchronous };
  else if (parsed && (source === parsed.source || source.startsWith(parsed.source))) previous.current = parsed;

  useEffect(() => {
    if (!asynchronous) {
      setParsed(undefined); // Release an obsolete large result after a short replacement/fallback.
      return;
    }
    try {
      subscription.current = getQueue().subscribe((parsedSource, fragments) => {
        // An older append is useful progress. An obsolete replacement or a
        // result for a disposed message must never overwrite the new source.
        if (latestSource.current === parsedSource || latestSource.current.startsWith(parsedSource)) setParsed({ source: parsedSource, fragments });
      }, () => setFailed(true));
    } catch { setFailed(true); }
    return () => { subscription.current?.dispose(); subscription.current = undefined; };
  }, [asynchronous]);

  useEffect(() => {
    if (asynchronous) subscription.current?.update(source);
  }, [source, asynchronous]);

  if (synchronous) return { fragments: synchronous, pending: false, unformatted: "" };
  const visible = previous.current;
  const compatible = visible && (source === visible.source || source.startsWith(visible.source));
  return { fragments: compatible ? visible.fragments : undefined, pending: !compatible || visible.source !== source, unformatted: compatible ? source.slice(visible.source.length) : source };
}
