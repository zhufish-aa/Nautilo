import { app, protocol } from "electron";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

export const ARTIFACT_SCHEME = "agenthub-artifact";

export function registerArtifactScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: ARTIFACT_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }]);
}

/** Streams only Nautilo-owned images; arbitrary file:// access stays blocked. */
export function registerArtifactProtocol(getWorkspaceRoots?: () => Promise<string[]>): void {
  const fixedRoots = [
    resolve(homedir(), ".codex", "generated_images"),
    resolve(app.getPath("userData"), "attachments")
  ];
  protocol.handle(ARTIFACT_SCHEME, async (request) => {
    const requestedPath = new URL(request.url).searchParams.get("path");
    if (!requestedPath) return new Response("Missing artifact path", { status: 400 });
    const workspaceRoots = await getWorkspaceRoots?.().catch(() => []) ?? [];
    const allowedRoots = [...fixedRoots, ...workspaceRoots.map((root) => resolve(root))];
    return readArtifactResponse(requestedPath, allowedRoots);
  });
}

/** Authorize the real file, then stream the same descriptor instead of reopening its path. */
export async function readArtifactResponse(requestedPath: string, allowedRoots: string[]): Promise<Response> {
  const candidate = resolve(requestedPath);
  const roots = (await Promise.all(allowedRoots.map((root) => realpath(root).catch(() => undefined))))
    .filter((root): root is string => root !== undefined);
  const actual = await realpath(candidate).catch(() => undefined);
  if (!actual) return new Response("Artifact not found", { status: 404 });
  if (!roots.some((root) => isWithin(root, actual))) return new Response("Forbidden", { status: 403 });
  const candidateInfo = await stat(actual).catch(() => undefined);
  if (!candidateInfo?.isFile()) return new Response("Artifact not found", { status: 404 });
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(actual, flags).catch(() => undefined);
  if (!handle) return new Response("Artifact not found", { status: 404 });
  let streaming = false;
  try {
    const info = await handle.stat();
    const current = await realpath(candidate).catch(() => undefined);
    const linked = current ? await stat(current).catch(() => undefined) : undefined;
    if (!info.isFile() || current !== actual || !linked || info.dev !== linked.dev || info.ino !== linked.ino) {
      return new Response("Artifact changed while opening", { status: 403 });
    }
    const headers = { "Content-Type": artifactMime(candidate), "X-Content-Type-Options": "nosniff" };
    if (info.size === 0) return new Response(null, { headers });
    // Cap the stream at the observed size if the file grows concurrently.
    // Closing/cancelling this stream closes the descriptor. Portable path
    // checks are not an OS sandbox against hostile same-user directory swaps.
    const stream = handle.createReadStream({ autoClose: true, start: 0, end: info.size - 1 });
    const response = new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers });
    streaming = true;
    return response;
  } finally {
    if (!streaming) await handle.close();
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function artifactMime(path: string): string {
  const types: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".avif": "image/avif",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".pdf": "application/pdf"
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}
