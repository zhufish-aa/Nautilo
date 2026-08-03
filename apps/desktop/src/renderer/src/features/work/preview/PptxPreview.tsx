import { useEffect, useRef, useState } from "react";
import { classifyPreviewError } from "../../../lib/work-preview";
import { openPptxSession, type PptxSession } from "./pptx-adapter";
import type { OfficePreviewProps } from "./types";

/**
 * PPTX preview rendered offline by @aiden0z/pptx-renderer inside an isolated
 * container. Slide navigation goes through the unified toolbar; the session
 * (viewer, blob URLs, observers) is disposed on file change and unmount.
 */
export function PptxPreview({ bytes, zoom, onNav, onReady, onError }: OfficePreviewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<PptxSession | null>(null);
  const [slide, setSlide] = useState(0);
  const [slideCount, setSlideCount] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const abort = new AbortController();
    let active: PptxSession | null = null;
    setSession(null);
    setSlide(0);
    setSlideCount(0);
    container.innerHTML = "";
    void (async () => {
      try {
        const opened = await openPptxSession(bytes, container, abort.signal);
        if (abort.signal.aborted) {
          opened.dispose();
          return;
        }
        active = opened;
        setSession(opened);
        setSlideCount(opened.slideCount);
        setSlide(0);
        opened.onSlideChange((index) => setSlide(index));
        onReady();
      } catch (error) {
        if (abort.signal.aborted) return;
        const name = error instanceof Error ? error.name : "";
        onError(error instanceof Error ? error.message : String(error), classifyPreviewError(name || "parse"));
      }
    })();
    return () => {
      abort.abort();
      active?.dispose();
      container.innerHTML = "";
    };
  }, [bytes, onReady, onError]);

  // Zoom/fit-width changes reuse the live session.
  useEffect(() => {
    if (!session) return;
    void session.applyZoom(zoom).catch(() => {
      /* zoom failures are non-fatal; the last good scale stays */
    });
  }, [session, zoom]);

  useEffect(() => {
    if (!session || slideCount === 0) {
      onNav(null);
      return;
    }
    onNav({
      kind: "slide",
      index: Math.min(slide, slideCount - 1),
      count: slideCount,
      prev: () => void session.goTo(Math.max(0, slide - 1)),
      next: () => void session.goTo(Math.min(slideCount - 1, slide + 1)),
      goto: (index) => void session.goTo(Math.min(slideCount - 1, Math.max(0, index)))
    });
    return () => onNav(null);
  }, [session, slide, slideCount, onNav]);

  return (
    <div className="h-full overflow-auto bg-card/40 p-4">
      {/* Third-party DOM is confined to this root; scoped styles below keep
          its internals from inheriting app typography. */}
      <div ref={containerRef} className="pptx-preview-root mx-auto w-fit text-left text-ink" aria-label="PPTX" />
    </div>
  );
}
