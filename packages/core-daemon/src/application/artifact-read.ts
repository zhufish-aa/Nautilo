import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
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
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new CoreError("IPC_INVALID_REQUEST", { field: "path", reason: "Path escapes the project workspace." });
  }
  const info = await stat(candidate).catch(() => undefined);
  if (!info?.isFile()) throw new CoreError("IPC_NOT_FOUND", { resource: "artifact", id: input.path });
  if (info.size > MAX_BYTES) {
    throw new CoreError("IPC_INVALID_REQUEST", { field: "path", reason: `File exceeds the ${MAX_BYTES / 1024 / 1024}MB preview limit.` });
  }
  const buffer = await readFile(candidate);
  return {
    base64: buffer.toString("base64"),
    mimeType: MIME_BY_EXT[extname(candidate).toLowerCase()] ?? "application/octet-stream",
    size: info.size,
    modifiedAt: info.mtime.toISOString()
  };
}
