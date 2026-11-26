import { useLayoutEffect, useRef, useState } from "react";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const BASE_RATE = 48;
const CATCH_UP_FACTOR = 5.5;
const CATCH_UP_MS = 240;
const DRAIN_MS = 130;

/** Slice at UTF-16 offsets obtained from complete graphemes. */
export function* streamGraphemes(source: string): Iterable<string> {
  for (const { segment } of graphemes.segment(source)) yield segment;
}

type Stream = {
  raw: string;
  ends: number[];
  shown: number;
  credit: number;
  rateFloor: number;
  lastTime: number;
  streaming: boolean;
  frame?: number;
};

function appendGraphemes(stream: Stream, raw: string): void {
  // The final grapheme can acquire a modifier or ZWJ in the next packet.
  stream.ends.pop();
  let end = stream.ends.at(-1) ?? 0;
  const available = /[\uD800-\uDBFF\u200D]$/.test(raw) ? raw.length - 1 : raw.length;
  for (const segment of streamGraphemes(raw.slice(end, available))) {
    end += segment.length;
    stream.ends.push(end);
  }
  stream.raw = raw;
}

function cancel(stream?: Stream): void {
  if (stream?.frame !== undefined) {
    cancelAnimationFrame(stream.frame);
    stream.frame = undefined;
  }
}

export function useSmoothStreamText(rawText: string, isStreaming: boolean, enabled = true, revealFromStart = false) {
  const [visible, setVisible] = useState(() => ({ text: revealFromStart && enabled && isStreaming ? "" : rawText, fade: false }));
  const stream = useRef<Stream>();

  useLayoutEffect(() => {
    if (!enabled || document.hidden) {
      cancel(stream.current);
      stream.current = undefined;
      setVisible({ text: rawText, fade: false });
      return;
    }
    if (!isStreaming && !stream.current) return;

    const now = performance.now();
    let queue = stream.current;
    if (!queue || !rawText.startsWith(queue.raw)) {
      cancel(queue);
      const seed = rawText.startsWith(visible.text) ? visible.text : rawText;
      queue = { raw: "", ends: [], shown: 0, credit: 0, rateFloor: 0, lastTime: now, streaming: isStreaming };
      appendGraphemes(queue, seed);
      queue.shown = queue.ends.length;
      stream.current = queue;
    }
    const current = queue;
    if (current.raw !== rawText) appendGraphemes(current, rawText);
    const backlog = current.ends.length - current.shown;
    if (!isStreaming && current.streaming) {
      current.rateFloor = backlog * 1_000 / DRAIN_MS;
      current.lastTime = now;
    } else {
      // Retain the floor as the backlog shrinks so large packets do not
      // spend their last few characters waiting at the baseline speed.
      current.rateFloor = Math.max(current.rateFloor, backlog * 1_000 / CATCH_UP_MS);
    }
    current.streaming = isStreaming;

    const finish = (fade: boolean): void => {
      current.credit = current.rateFloor = 0;
      if (!current.streaming) stream.current = undefined;
      setVisible({ text: current.streaming ? current.raw.slice(0, current.ends.at(-1) ?? 0) : current.raw, fade });
    };
    const tick = (time: number): void => {
      current.frame = undefined;
      const remaining = current.ends.length - current.shown;
      const dt = Math.min(Math.max(0, time - current.lastTime), 50) / 1_000;
      current.lastTime = time;
      // Integrate the diminishing backlog over elapsed time, rather than
      // multiplying the rate at the start of a frame by that frame's length.
      const extra = Math.max(0, remaining - current.credit - 20);
      const caughtUp = (extra + BASE_RATE / CATCH_UP_FACTOR) * -Math.expm1(-CATCH_UP_FACTOR * dt);
      current.credit += Math.max(Math.max(current.rateFloor, BASE_RATE) * dt, caughtUp);
      const advance = Math.min(remaining, Math.floor(current.credit));
      current.credit -= advance;
      current.shown += advance;
      if (current.shown < current.ends.length) {
        if (advance) setVisible({ text: current.raw.slice(0, current.ends[current.shown - 1]), fade: true });
        current.frame = requestAnimationFrame(tick);
      } else finish(advance > 0);
    };
    if (backlog > 0) {
      if (current.frame === undefined) {
        current.lastTime = now;
        current.frame = requestAnimationFrame(tick);
      }
    } else finish(false);
  }, [rawText, isStreaming, enabled]);

  useLayoutEffect(() => {
    const sync = (): void => {
      const current = stream.current;
      cancel(current);
      stream.current = undefined;
      if (current) setVisible({ text: current.raw, fade: false });
    };
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      cancel(stream.current);
    };
  }, []);

  return enabled && (isStreaming || stream.current) && rawText.startsWith(visible.text) && !globalThis.document?.hidden
    ? visible : { text: rawText, fade: false };
}
