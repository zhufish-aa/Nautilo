import type { PreviewZoom } from "./types";

/**
 * Narrow adapter around @aiden0z/pptx-renderer. The third-party viewer only
 * ever touches the container element we hand it; all of its DOM, blob URLs
 * and observers are reclaimed through dispose(). Nothing here is uploaded —
 * parsing and rendering run fully offline in the renderer process.
 */
export interface PptxSession {
  readonly slideCount: number;
  goTo(index: number): Promise<void>;
  applyZoom(zoom: PreviewZoom): Promise<void>;
  onSlideChange(callback: (index: number) => void): void;
  dispose(): void;
}

export async function openPptxSession(
  bytes: Uint8Array,
  container: HTMLElement,
  signal: AbortSignal
): Promise<PptxSession> {
  const [{ PptxViewer, RECOMMENDED_ZIP_LIMITS }, pdfModule, pdfWorker] = await Promise.all([
    import("@aiden0z/pptx-renderer"),
    // Local pdf.js assets for the optional EMF-embedded-PDF fallback — no CDN.
    import("pdfjs-dist/build/pdf.min.mjs?url"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url")
  ]);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  const viewer = await PptxViewer.open(bytes, container, {
    renderMode: "slide",
    fitMode: "contain",
    zipLimits: RECOMMENDED_ZIP_LIMITS,
    lazySlides: true,
    lazyMedia: true,
    pdfjs: { moduleUrl: pdfModule.default, workerUrl: pdfWorker.default },
    signal
  });

  return {
    get slideCount(): number {
      return viewer.slideCount;
    },
    goTo: (index) => viewer.goToSlide(index),
    applyZoom: async (zoom) => {
      // "contain" fits the slide to the container width; numeric zoom renders
      // at intrinsic size scaled by the percentage.
      if (zoom === "fit-width") await viewer.setFitMode("contain");
      else {
        await viewer.setFitMode("none");
        await viewer.setZoom(zoom);
      }
    },
    onSlideChange: (callback) => {
      viewer.on("slidechange", (event) => callback(event.detail.index));
    },
    dispose: () => viewer.destroy()
  };
}
