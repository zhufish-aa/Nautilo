import { useEffect, useRef, useState } from "react";
import { classifyPreviewError } from "../../../lib/work-preview";
import type { OfficePreviewProps } from "./types";

type PdfjsModule = typeof import("pdfjs-dist");
type PdfDocument = Awaited<ReturnType<PdfjsModule["getDocument"]>["promise"]>;

// One shared, lazily created pdf.js instance — keeps the engine out of the
// first-paint bundle and configures a local worker (no CDN).
let pdfjsPromise: Promise<PdfjsModule> | undefined;
function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url")
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  return pdfjsPromise;
}

/**
 * Canvas-based PDF preview: page navigation, jump-to-page, zoom and
 * fit-width. Render tasks are cancelled on every page/zoom change and the
 * document is destroyed on unmount so no worker state leaks between files.
 */
export function PdfPreview({ bytes, zoom, onNav, onReady, onError }: OfficePreviewProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);

  // Load the document; bytes identity changes per file version.
  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<PdfjsModule["getDocument"]> | undefined;
    setDoc(null);
    setPage(1);
    setPageCount(0);
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (cancelled) return;
        // pdf.js transfers the buffer to its worker — hand it a copy so the
        // caller's bytes stay usable for reloads.
        loadingTask = pdfjs.getDocument({ data: bytes.slice() });
        const document = await loadingTask.promise;
        if (cancelled) {
          void document.destroy();
          return;
        }
        setDoc(document);
        setPageCount(document.numPages);
        setPage(1);
      } catch (error) {
        if (cancelled) return;
        const name = error instanceof Error ? error.name : "";
        onError(error instanceof Error ? error.message : String(error), classifyPreviewError(name));
      }
    })();
    return () => {
      cancelled = true;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [bytes, onError]);

  // Render the current page; re-runs on zoom/fit changes.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let renderTask: { cancel(): void; promise: Promise<void> } | undefined;
    void (async () => {
      try {
        const pdfPage = await doc.getPage(page);
        if (cancelled) return;
        const canvas = canvasRef.current;
        const scroll = scrollRef.current;
        if (!canvas || !scroll) return;
        const baseViewport = pdfPage.getViewport({ scale: 1 });
        const available = Math.max(64, scroll.clientWidth - 32);
        const scale = zoom === "fit-width" ? available / baseViewport.width : zoom / 100;
        const dpr = window.devicePixelRatio || 1;
        const viewport = pdfPage.getViewport({ scale: scale * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        const context = canvas.getContext("2d");
        if (!context) return;
        renderTask = pdfPage.render({ canvas, canvasContext: context, viewport });
        await renderTask.promise;
        if (!cancelled) onReady();
      } catch (error) {
        if (cancelled) return;
        const name = error instanceof Error ? error.name : "";
        if (name === "RenderingCancelledException") return;
        onError(error instanceof Error ? error.message : String(error), classifyPreviewError(name));
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, page, zoom, onReady, onError]);

  // Publish navigation to the unified toolbar.
  useEffect(() => {
    if (!doc || pageCount === 0) {
      onNav(null);
      return;
    }
    onNav({
      kind: "page",
      index: page - 1,
      count: pageCount,
      prev: () => setPage((current) => Math.max(1, current - 1)),
      next: () => setPage((current) => Math.min(pageCount, current + 1)),
      goto: (index) => setPage(Math.min(pageCount, Math.max(1, index + 1)))
    });
    return () => onNav(null);
  }, [doc, page, pageCount, onNav]);

  return (
    <div ref={scrollRef} className="h-full overflow-auto bg-card/40 p-4">
      <canvas ref={canvasRef} className="mx-auto block rounded-sm bg-white shadow-md" aria-label="PDF" />
    </div>
  );
}
