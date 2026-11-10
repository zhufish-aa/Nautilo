import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { AdapterStartRequest } from "./types.js";

export function imagePromptBlocks(request: AdapterStartRequest, anthropic = false): Record<string, unknown>[] {
  return [{ type: "text", text: request.prompt }, ...(request.localImagePaths ?? []).map(path => {
    const mimeType = ({ '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp' } as Record<string, string>)[extname(path).toLowerCase()];
    if (!mimeType) throw new Error(`Unsupported image attachment: ${path}`);
    const bytes = readFileSync(resolve(request.cwd, path));
    if (!bytes.length) throw new Error(`Image attachment is empty: ${path}`);
    const data = bytes.toString("base64");
    return anthropic ? { type:"image", source:{type:"base64",media_type:mimeType,data} } : {type:"image",mimeType,data};
  })];
}

export function promptWithImageFiles(request: AdapterStartRequest): string {
  if (!request.localImagePaths?.length) return request.prompt;
  imagePromptBlocks(request);
  return request.prompt + "\n\nAttached images (inspect them with your native file/image reader):\n"
    + request.localImagePaths.map(path => "- " + JSON.stringify(resolve(request.cwd,path))).join("\n");
}
