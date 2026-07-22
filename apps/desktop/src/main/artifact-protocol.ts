import { app, net, protocol } from "electron";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ARTIFACT_SCHEME = "agenthub-artifact";

export function registerArtifactScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: ARTIFACT_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }]);
}

/** Streams only AgentHub-owned images; arbitrary file:// access stays blocked. */
export function registerArtifactProtocol(): void {
  const allowedRoots = [
    resolve(homedir(), ".codex", "generated_images"),
    resolve(app.getPath("userData"), "attachments")
  ];
  protocol.handle(ARTIFACT_SCHEME, (request) => {
    const requestedPath = new URL(request.url).searchParams.get("path");
    if (!requestedPath) return new Response("Missing artifact path", { status: 400 });
    const candidate = resolve(requestedPath);
    if (!allowedRoots.some((root) => isWithin(root, candidate))) return new Response("Forbidden", { status: 403 });
    if (!existsSync(candidate)) return new Response("Artifact not found", { status: 404 });
    return net.fetch(pathToFileURL(candidate).toString());
  });
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
