/**
 * Work-mode preview registry: maps a workspace deliverable to the renderer
 * that can display it. Pure detection, error classification and cache helpers
 * live here so they stay unit-testable; the heavy parsers (pdfjs-dist /
 * docx-preview / SheetJS / @aiden0z/pptx-renderer / mammoth) are lazily
 * imported by the pane components under features/work/preview.
 *
 * The code-text extension list is shared with file-references.ts so chat
 * chips and the preview registry never drift apart. The unit tests inline
 * this single import when transpiling the module standalone.
 */
import { CODE_EXTENSIONS } from "./file-references";

export type WorkPreviewKind =
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "legacy-office"
  | "markdown"
  | "html"
  | "csv"
  | "image"
  | "text"
  | "binary";

/** Kinds rendered by the async office components (parsing state applies). */
export const OFFICE_KINDS: readonly WorkPreviewKind[] = ["pdf", "docx", "xlsx", "pptx"];

export interface PreviewRendererDef {
  kind: WorkPreviewKind;
  /** Lowercase extensions including the leading dot. */
  extensions: readonly string[];
  /**
   * Lowercase MIME types. An entry ending with "/" is a prefix match
   * (e.g. "image/" covers any image/* subtype).
   */
  mimeTypes: readonly string[];
}

/**
 * Adding support for a new file class means appending one entry here and,
 * for office-style documents, one component in features/work/preview.
 */
export const PREVIEW_REGISTRY: readonly PreviewRendererDef[] = [
  { kind: "pdf", extensions: [".pdf"], mimeTypes: ["application/pdf"] },
  {
    kind: "docx",
    extensions: [".docx"],
    mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
  },
  {
    kind: "xlsx",
    extensions: [".xlsx", ".xls"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel"
    ]
  },
  {
    kind: "pptx",
    extensions: [".pptx"],
    mimeTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"]
  },
  {
    kind: "legacy-office",
    extensions: [".doc", ".ppt"],
    mimeTypes: ["application/msword", "application/vnd.ms-powerpoint"]
  },
  { kind: "markdown", extensions: [".md", ".markdown"], mimeTypes: ["text/markdown"] },
  { kind: "html", extensions: [".html", ".htm"], mimeTypes: ["text/html"] },
  { kind: "csv", extensions: [".csv", ".tsv"], mimeTypes: ["text/csv", "text/tab-separated-values"] },
  {
    kind: "image",
    extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"],
    mimeTypes: ["image/"]
  },
  {
    kind: "text",
    // Code/config files render as plain text too (.py included); markdown,
    // html and csv entries above win first-match precedence for shared exts.
    extensions: [...new Set([".txt", ".json", ".log", ".xml", ".yaml", ".yml", ...CODE_EXTENSIONS.map((ext) => `.${ext}`)])],
    mimeTypes: ["text/plain", "application/json"]
  }
];

export function fileExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  return path.slice(dot).toLowerCase();
}

/**
 * Resolves the preview kind from the file extension first, then from the
 * daemon-reported MIME type. Both checks are case-insensitive; unknown input
 * safely falls back to "binary".
 */
export function resolvePreview(path: string, mimeType?: string): WorkPreviewKind {
  const ext = fileExtension(path);
  if (ext) {
    for (const def of PREVIEW_REGISTRY) {
      if (def.extensions.includes(ext)) return def.kind;
    }
  }
  const mime = mimeType?.trim().toLowerCase();
  if (mime) {
    for (const def of PREVIEW_REGISTRY) {
      for (const entry of def.mimeTypes) {
        if (entry.endsWith("/") ? mime.startsWith(entry) : mime === entry) return def.kind;
      }
    }
  }
  return "binary";
}

/** Extension-only lookup kept for call sites that have no MIME information. */
export function previewKind(path: string): WorkPreviewKind {
  return resolvePreview(path);
}

export type PreviewErrorReason = "too-large" | "encrypted" | "corrupted" | "engine-load" | "unknown";

/** The daemon already caps artifact.read at 20MB; mirror it for early UI feedback. */
export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

/**
 * Maps parser/library error names to user-understandable reasons. Kept pure
 * so every office component shares the same classification.
 */
export function classifyPreviewError(errorName: string): PreviewErrorReason {
  const name = errorName.toLowerCase();
  if (name.includes("password")) return "encrypted";
  if (
    name.includes("invalidpdf") ||
    name.includes("corrupt") ||
    name.includes("zip") ||
    name.includes("parse") ||
    name.includes("invalid")
  ) {
    return "corrupted";
  }
  if (name.includes("load") || name.includes("import") || name.includes("network")) return "engine-load";
  return "unknown";
}

export interface LruCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  clear(): void;
  readonly size: number;
}

/** Bounded LRU cache — hits refresh recency, inserts evict the oldest entry. */
export function createLruCache<V>(limit: number): LruCache<V> {
  const map = new Map<string, V>();
  return {
    get size(): number {
      return map.size;
    },
    get(key: string): V | undefined {
      const value = map.get(key);
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set(key: string, value: V): void {
      if (map.has(key)) map.delete(key);
      else if (map.size >= limit) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, value);
    },
    clear(): void {
      map.clear();
    }
  };
}

/** Cache key: a parsed preview is only valid for one file version. */
export function previewCacheKey(projectId: string, path: string, modifiedAt: string): string {
  return `${projectId}:${path}:${modifiedAt}`;
}

/** Case/separator-insensitive key for deduplicating tab paths (Windows-safe). */
export function normalizePathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * Deliverable tab list with a chat-requested file merged in: the requested
 * path becomes the first tab when it is not already among the deliverables
 * (compared case- and separator-insensitively); existing order is preserved.
 */
export function mergeDeliverableTabs(deliverables: string[], requestedPath?: string): string[] {
  if (!requestedPath) return deliverables;
  const key = normalizePathKey(requestedPath);
  if (deliverables.some((path) => normalizePathKey(path) === key)) return deliverables;
  return [requestedPath, ...deliverables];
}

/**
 * The tab path a chat-requested preview should select: prefers the existing
 * deliverable's exact form (so artifact.read keeps a known-good path) and
 * falls back to the requested path itself.
 */
export function resolveRequestedTab(deliverables: string[], requestedPath: string): string {
  const key = normalizePathKey(requestedPath);
  return deliverables.find((path) => normalizePathKey(path) === key) ?? requestedPath;
}

export interface VisibleRange {
  start: number;
  end: number;
  truncated: boolean;
}

/**
 * Chunk planning for large spreadsheets: rows render in fixed-size windows so
 * huge sheets never mount thousands of DOM rows at once.
 */
export function planVisibleRange(totalRows: number, renderedRows: number, chunkSize: number): VisibleRange {
  if (totalRows <= 0) return { start: 0, end: 0, truncated: false };
  const end = Math.min(totalRows, Math.max(renderedRows, chunkSize));
  return { start: 0, end, truncated: end < totalRows };
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

/** Mammoth fallback for DOCX when docx-preview cannot parse the file. */
export async function docxToHtml(bytes: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer });
  return result.value;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
