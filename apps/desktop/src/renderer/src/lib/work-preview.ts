/**
 * Work-mode preview engine: decides how a workspace deliverable renders in the
 * preview pane. Pure kind detection lives here so it stays unit-testable; the
 * heavy parsers (mammoth / SheetJS) are loaded lazily by the pane component.
 */
export type WorkPreviewKind =
  | "docx"
  | "xlsx"
  | "pptx-unsupported"
  | "markdown"
  | "html"
  | "csv"
  | "image"
  | "text"
  | "binary";

const KIND_BY_EXT: Record<string, WorkPreviewKind> = {
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".xls": "xlsx",
  ".pptx": "pptx-unsupported",
  ".ppt": "pptx-unsupported",
  ".md": "markdown",
  ".markdown": "markdown",
  ".html": "html",
  ".htm": "html",
  ".csv": "csv",
  ".tsv": "csv",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".svg": "image",
  ".txt": "text",
  ".json": "text",
  ".log": "text",
  ".xml": "text",
  ".yaml": "text",
  ".yml": "text"
};

export function previewKind(path: string): WorkPreviewKind {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return KIND_BY_EXT[ext] ?? "binary";
}

/** Decodes the daemon's base64 payload once, shared by every renderer. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function base64ToText(base64: string): string {
  return new TextDecoder("utf-8").decode(base64ToBytes(base64));
}

export async function docxToHtml(bytes: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer });
  return result.value;
}

export async function xlsxToHtml(bytes: Uint8Array): Promise<string> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(bytes, { type: "array" });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) return "<p>(empty workbook)</p>";
  return XLSX.utils.sheet_to_html(workbook.Sheets[firstSheet]!);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
