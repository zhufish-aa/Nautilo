import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../lib/i18n";
import { classifyPreviewError, docxToHtml } from "../../../lib/work-preview";
import type { OfficePreviewProps } from "./types";

/**
 * DOCX preview via docx-preview (page containers), with Mammoth as a
 * degraded-layout fallback when the primary parser fails. Generated DOM and
 * styles live under our own root with a dedicated class prefix, images are
 * inlined as base64 data URLs (no blob URLs, no remote resources), and the
 * whole tree is discarded on file change/unmount.
 */
export function DocxPreview({ bytes, zoom, onNav, onReady, onError }: OfficePreviewProps): JSX.Element {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const [fallbackHtml, setFallbackHtml] = useState<string>();

  // Continuous document — no pager for the toolbar.
  useEffect(() => {
    onNav(null);
  }, [onNav]);

  useEffect(() => {
    let cancelled = false;
    const root = rootRef.current;
    if (!root) return;
    root.innerHTML = "";
    setFallbackHtml(undefined);
    setContentWidth(0);
    void (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        if (cancelled) return;
        // Style container stays inside our root so docx-preview never writes
        // <style> tags into document.head.
        const styleContainer = document.createElement("div");
        const bodyContainer = document.createElement("div");
        root.append(styleContainer, bodyContainer);
        await renderAsync(bytes, bodyContainer, styleContainer, {
          className: "work-docx",
          inWrapper: true,
          breakPages: true,
          ignoreHeight: true,
          useBase64URL: true,
          renderHeaders: true,
          renderFooters: true
        });
        if (cancelled) return;
        const wrapper = bodyContainer.querySelector<HTMLElement>(".work-docx-wrapper");
        setContentWidth(wrapper?.scrollWidth || bodyContainer.scrollWidth || root.clientWidth);
        onReady();
      } catch (error) {
        if (cancelled) return;
        // Degraded fallback: Mammoth HTML keeps content readable but page
        // layout, headers/footers and exact styling may differ.
        try {
          const html = await docxToHtml(bytes);
          if (cancelled) return;
          setFallbackHtml(html);
          onReady();
        } catch (fallbackError) {
          if (cancelled) return;
          const failure = fallbackError instanceof Error ? fallbackError : error;
          const name = failure instanceof Error ? failure.name : "";
          onError(
            failure instanceof Error ? failure.message : String(failure),
            classifyPreviewError(name || "parse")
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      root.innerHTML = "";
    };
  }, [bytes, onReady, onError]);

  // Fit-width: re-measure available space on container resize.
  useEffect(() => {
    if (zoom !== "fit-width") return;
    const scroll = scrollRef.current;
    if (!scroll || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const wrapper = rootRef.current?.querySelector<HTMLElement>(".work-docx-wrapper");
      const width = wrapper?.scrollWidth;
      if (width) setContentWidth(width);
    });
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [zoom]);

  const available = Math.max(64, (scrollRef.current?.clientWidth ?? 640) - 48);
  const scale = zoom === "fit-width" ? (contentWidth > 0 ? Math.min(1.5, available / contentWidth) : 1) : zoom / 100;

  return (
    <div ref={scrollRef} className="h-full overflow-auto bg-card/40 px-4 py-5">
      {fallbackHtml !== undefined ? (
        <div className="mx-auto max-w-3xl">
          <p className="mb-3 rounded-md bg-accent-soft px-3 py-1.5 text-[11px] text-accent">
            {t("work.preview.docxFallback")}
          </p>
          <div
            className="work-preview-doc prose-sm text-ink [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line [&_th]:bg-card-hover [&_th]:px-2 [&_th]:py-1"
            dangerouslySetInnerHTML={{ __html: fallbackHtml }}
          />
        </div>
      ) : (
        // Chromium supports CSS zoom: it scales layout (not just paint), so
        // page containers keep their proportions at any zoom level.
        <div ref={rootRef} className="work-docx-root mx-auto w-fit" style={{ zoom: scale }} />
      )}
    </div>
  );
}
