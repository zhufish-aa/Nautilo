import { DocxPreview } from "./DocxPreview";
import { PdfPreview } from "./PdfPreview";
import { PptxPreview } from "./PptxPreview";
import { SpreadsheetPreview } from "./SpreadsheetPreview";
import type { OfficePreviewProps } from "./types";

/**
 * Dispatcher for office deliverables (pdf/docx/xlsx/pptx). Each renderer is
 * an isolated component that reports parsing progress and navigation up to
 * the pane, which owns the unified toolbar and state machine.
 */
export function DocumentPreview(props: OfficePreviewProps): JSX.Element {
  switch (props.kind) {
    case "pdf":
      return <PdfPreview {...props} />;
    case "docx":
      return <DocxPreview {...props} />;
    case "xlsx":
      return <SpreadsheetPreview {...props} />;
    case "pptx":
      return <PptxPreview {...props} />;
  }
}
