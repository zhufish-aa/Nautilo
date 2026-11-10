import { open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { IpcRequestMap } from "@agenthub/schemas";
import type { Database } from "../database/index.js";
import { CoreError } from "../errors.js";

const MAX_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".py": "text/plain",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf"
};

/**
 * Reads a file for the Work-mode preview pane. The path must resolve inside
 * the owning project's workspace root — absolute paths are allowed (agents
 * report them) but still have to land under rootPath.
 */
export async function readWorkspaceArtifact(
  database: Database,
  input: IpcRequestMap["artifact.read"]["input"]
): Promise<IpcRequestMap["artifact.read"]["output"]> {
  const project = database.projects.get(input.projectId);
  if (!project) throw new CoreError("IPC_NOT_FOUND", { resource: "project", id: input.projectId });
  const root = resolve(project.rootPath);
  const candidate = isAbsolute(input.path) ? resolve(input.path) : resolve(root, input.path);
  const inside = (base: string, path: string): boolean => {
    const rel = relative(base, path);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const escaped = (): CoreError => new CoreError("IPC_INVALID_REQUEST", { field: "path", reason: "Path escapes the project workspace or changed while opening." });
  const canonicalRoot = await realpath(root).catch(() => undefined);
  if (!canonicalRoot) throw new CoreError("IPC_NOT_FOUND", { resource: "artifact", id: input.path });
  const canonicalPath = await realpath(candidate).catch(() => undefined);
  if (!canonicalPath) {
    if (!inside(root, candidate) && !inside(canonicalRoot, candidate)) throw escaped();
    throw new CoreError("IPC_NOT_FOUND", { resource: "artifact", id: input.path });
  }
  if (!inside(canonicalRoot, canonicalPath)) throw escaped();
  const candidateInfo = await stat(canonicalPath).catch(() => undefined);
  if (!candidateInfo?.isFile()) throw new CoreError("IPC_NOT_FOUND", { resource: "artifact", id: input.path });
  // O_NONBLOCK avoids hanging on a FIFO substituted after stat on Unix;
  // O_NOFOLLOW rejects a last-component symlink substituted before open.
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(canonicalPath, flags).catch(() => undefined);
  if (!handle) throw new CoreError("IPC_NOT_FOUND", { resource: "artifact", id: input.path });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new CoreError("IPC_NOT_FOUND", { resource: "artifact", id: input.path });
    // Use the opened file for both metadata and bytes. Recheck the original
    // path and inode to catch symlink/replacement races during open. These
    // portable checks are not an OS sandbox against a hostile same-user writer.
    const validateOpenedPath = async (): Promise<void> => {
      const current = await realpath(candidate).catch(() => undefined);
      if (!current || current !== canonicalPath || !inside(canonicalRoot, current)) throw escaped();
      const linked = await stat(current).catch(() => undefined);
      if (!linked || linked.dev !== info.dev || linked.ino !== info.ino) throw escaped();
    };
    await validateOpenedPath();
    const tooLarge = (): CoreError => new CoreError("IPC_INVALID_REQUEST", { field: "path", reason: `File exceeds the ${MAX_BYTES / 1024 / 1024}MB preview limit.` });
    if (info.size > MAX_BYTES) throw tooLarge();
    // Read at most the limit plus one byte even if the file grows after stat.
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= MAX_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw tooLarge();
    await validateOpenedPath();
    const buffer = Buffer.concat(chunks, size);
    return {
      base64: buffer.toString("base64"),
      mimeType: MIME_BY_EXT[extname(candidate).toLowerCase()] ?? "application/octet-stream",
      size: buffer.length,
      modifiedAt: info.mtime.toISOString()
    };
  } finally {
    await handle.close();
  }
}
