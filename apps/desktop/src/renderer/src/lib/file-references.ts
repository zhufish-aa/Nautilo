/**
 * Conservative file-reference detection for chat messages.
 *
 * Two entry points:
 * - parseFileReference: validates a whole string (inline code content), bare
 *   filenames like `Timeline.tsx:42` are accepted.
 * - findFileReferences: scans plain text; only paths containing a separator
 *   and ending in a known file extension are matched, so ordinary English
 *   phrases are never turned into chips.
 */

export interface FileReference {
  path: string;
  line?: number;
}

const CODE_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "css", "scss", "less", "json", "md", "mdx",
  "py", "rs", "go", "java", "kt", "kts", "c", "h", "cc", "cpp", "hpp", "cs",
  "rb", "php", "swift", "vue", "svelte", "html", "htm", "xml",
  "yaml", "yml", "toml", "ini", "sql", "sh", "bash", "zsh", "ps1", "bat",
  "prisma", "graphql", "gql", "proto", "txt", "log",
  // Office deliverables (Work mode outputs): detected so message text turns
  // them into chips; they open with the system app instead of the preview.
  "pptx", "ppt", "docx", "doc", "xlsx", "xls", "csv", "pdf"
];

/** Extensions whose files open with the OS default app rather than the in-app preview. */
const EXTERNAL_OPEN_EXTENSIONS = new Set(["pptx", "ppt", "docx", "doc", "xlsx", "xls", "csv", "pdf"]);

/** True when a referenced path should be opened externally (Office documents etc.). */
export function isExternalOpenPath(path: string): boolean {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 && EXTERNAL_OPEN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

const CODE_EXTENSION_SET = new Set(CODE_EXTENSIONS);
const EXTENSION_PATTERN = CODE_EXTENSIONS.join("|");

// dir/segments/file.ext with an optional drive letter and an optional
// :line or :start-end suffix. Segment characters are Unicode-aware so
// non-ASCII (e.g. Chinese) folder names match.
const PLAIN_REF_REGEX = new RegExp(
  `(?:^|(?<=[\\s"'\`(\\[{<]))((?:[A-Za-z]:[\\\\/]?)?(?:[\\p{L}\\p{N}_@.~+-]+[\\\\/])+[\\p{L}\\p{N}_@.~+-]+\\.(?:${EXTENSION_PATTERN}))(?::(\\d+)(?:-\\d+)?)?(?![\\p{L}\\p{N}_./\\\\-])`,
  "giu"
);

const LINE_SUFFIX_REGEX = /:(\d+)(?:-\d+)?$/;
const LINE_PAREN_SUFFIX_REGEX = /\s*\((?:line|lines)\s+(\d+)(?:\s*[-–]\s*\d+)?\)\s*$/i;
const FORBIDDEN_PATH_CHARS = /[\s*?"<>|]/;

function hasKnownExtension(path: string): boolean {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return CODE_EXTENSION_SET.has(name.slice(dot + 1).toLowerCase());
}

function sanitizePath(raw: string): string | undefined {
  let path = raw.trim().replace(/[.,;]+$/, "");
  if (path.startsWith("./") || path.startsWith(".\\")) path = path.slice(2);
  if (!path || path.includes("://") || FORBIDDEN_PATH_CHARS.test(path)) return undefined;
  if (!hasKnownExtension(path)) return undefined;
  return path;
}

/** Validates a complete string (e.g. inline-code content) as a file reference. */
export function parseFileReference(text: string, { allowBare = true }: { allowBare?: boolean } = {}): FileReference | null {
  let value = text.trim();
  if (!value) return null;

  let line: number | undefined;
  const parenMatch = value.match(LINE_PAREN_SUFFIX_REGEX);
  if (parenMatch) {
    line = Number(parenMatch[1]);
    value = value.slice(0, parenMatch.index);
  } else {
    const colonMatch = value.match(LINE_SUFFIX_REGEX);
    // Guard: don't eat the colon of a bare Windows drive root like "C:".
    if (colonMatch && colonMatch.index !== undefined && colonMatch.index > 1) {
      line = Number(colonMatch[1]);
      value = value.slice(0, colonMatch.index);
    }
  }

  const path = sanitizePath(value);
  if (!path) return null;
  if (!allowBare && !path.includes("/") && !path.includes("\\")) return null;
  return { path, line };
}

export interface FileReferenceMatch extends FileReference {
  start: number;
  end: number;
}

/** Scans plain text for path-shaped tokens (separator + known extension). */
export function findFileReferences(text: string): FileReferenceMatch[] {
  const matches: FileReferenceMatch[] = [];
  PLAIN_REF_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLAIN_REF_REGEX.exec(text)) !== null) {
    const rawPath = match[1];
    const path = sanitizePath(rawPath);
    if (!path) continue;
    // Only real paths here — bare filenames must come via inline code.
    if (!path.includes("/") && !path.includes("\\")) continue;
    const start = match.index;
    const end = start + rawPath.length + (match[2] ? match[0].length - rawPath.length : 0);
    matches.push({ path, line: match[2] ? Number(match[2]) : undefined, start, end });
  }
  return matches;
}

/** Splits plain text into segments, marking file references. */
export function splitTextByFileReferences(text: string): Array<{ kind: "text"; value: string } | { kind: "reference"; value: string; reference: FileReference }> {
  const references = findFileReferences(text);
  if (references.length === 0) return [{ kind: "text", value: text }];
  const segments: Array<{ kind: "text"; value: string } | { kind: "reference"; value: string; reference: FileReference }> = [];
  let cursor = 0;
  for (const reference of references) {
    if (reference.start < cursor) continue;
    if (reference.start > cursor) segments.push({ kind: "text", value: text.slice(cursor, reference.start) });
    segments.push({ kind: "reference", value: text.slice(reference.start, reference.end), reference });
    cursor = reference.end;
  }
  if (cursor < text.length) segments.push({ kind: "text", value: text.slice(cursor) });
  return segments;
}
