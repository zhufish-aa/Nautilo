import { randomUUID } from "node:crypto";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

export interface DesktopAttachment {
  path: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  sizeBytes: number;
}

const MAX_CLIPBOARD_BYTES = 32 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif"]);

export async function describeAttachmentPaths(paths: string[]): Promise<DesktopAttachment[]> {
  return Promise.all(paths.map(async (path) => {
    const file = await stat(path);
    if (!file.isFile()) throw new Error(`Attachment is not a file: ${path}`);
    const name = basename(path);
    const mimeType = inferMimeType(name);
    return { path, name, sizeBytes: file.size, kind: mimeType?.startsWith("image/") ? "image" : "file", mimeType };
  }));
}

/** Copies previewable images into app-owned storage; large non-images stay path references. */
export async function prepareAttachmentPaths(dataDir: string, paths: string[]): Promise<DesktopAttachment[]> {
  const described = await describeAttachmentPaths(paths);
  const directory = resolve(dataDir, "attachments", "selected");
  await mkdir(directory, { recursive: true });
  return Promise.all(described.map(async (attachment) => {
    if (attachment.kind !== "image" || isWithin(resolve(dataDir, "attachments"), resolve(attachment.path))) return attachment;
    const extension = extname(attachment.name).slice(0, 16);
    const path = join(directory, `${randomUUID()}${extension}`);
    await copyFile(attachment.path, path);
    return { ...attachment, path };
  }));
}

/** Stores clipboard-only blobs once so Core can pass a stable path to CLIs. */
export async function importClipboardAttachment(
  dataDir: string,
  input: { name: string; mimeType?: string; data: Uint8Array }
): Promise<DesktopAttachment> {
  const bytes = Buffer.from(input.data);
  if (!bytes.length || bytes.length > MAX_CLIPBOARD_BYTES) {
    throw new Error(`Clipboard attachment must be between 1 byte and ${MAX_CLIPBOARD_BYTES} bytes`);
  }
  const originalExtension = extname(input.name).slice(0, 16);
  const extension = originalExtension || extensionForMime(input.mimeType);
  const directory = join(dataDir, "attachments", "clipboard");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${randomUUID()}${extension}`);
  await writeFile(path, bytes, { flag: "wx" });
  const mimeType = input.mimeType || inferMimeType(input.name);
  return {
    path,
    name: input.name || `clipboard${extension}`,
    sizeBytes: bytes.length,
    kind: mimeType?.startsWith("image/") ? "image" : "file",
    mimeType
  };
}

function inferMimeType(name: string): string | undefined {
  const extension = extname(name).toLowerCase();
  const known: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".avif": "image/avif",
    ".pdf": "application/pdf", ".json": "application/json", ".txt": "text/plain", ".md": "text/markdown",
    ".csv": "text/csv", ".html": "text/html", ".ts": "text/typescript", ".tsx": "text/typescript",
    ".js": "text/javascript", ".jsx": "text/javascript"
  };
  return known[extension] ?? (IMAGE_EXTENSIONS.has(extension) ? `image/${extension.slice(1)}` : undefined);
}

function extensionForMime(mimeType?: string): string {
  const extensions: Record<string, string> = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
    "image/bmp": ".bmp", "image/svg+xml": ".svg", "application/pdf": ".pdf", "text/plain": ".txt"
  };
  return mimeType ? extensions[mimeType] ?? "" : "";
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
