import type { PreviewErrorReason, WorkPreviewKind } from "../../../lib/work-preview";

/** Zoom controlled by the pane toolbar; "fit-width" lets the renderer compute scale. */
export type PreviewZoom = number | "fit-width";

export type PreviewNavKind = "page" | "slide" | "sheet";

/** Navigation handle an office renderer publishes to the unified toolbar. */
export interface PreviewNavState {
  kind: PreviewNavKind;
  /** 0-based current position. */
  index: number;
  count: number;
  prev(): void;
  next(): void;
  goto(index: number): void;
}

export interface OfficePreviewProps {
  path: string;
  kind: Extract<WorkPreviewKind, "pdf" | "docx" | "xlsx" | "pptx">;
  bytes: Uint8Array;
  zoom: PreviewZoom;
  /** Called whenever navigation becomes (un)available or the position changes. */
  onNav(nav: PreviewNavState | null): void;
  onReady(): void;
  onError(message: string, reason: PreviewErrorReason): void;
}
