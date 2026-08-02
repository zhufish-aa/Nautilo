import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import type { RuntimeToolSpec } from "../runtime-tools.js";
import type { AdapterResumeRequest, AdapterStartRequest } from "../types.js";

type RecordValue = Record<string, unknown>;
type CodexImageRequest = AdapterStartRequest | AdapterResumeRequest;

export const CODEX_IMAGE_GENERATION_TOOL_NAME = "image_gen";

export const CODEX_IMAGE_GENERATION_TOOL: RuntimeToolSpec = {
  name: CODEX_IMAGE_GENERATION_TOOL_NAME,
  description: "Generate an image through the configured AgentHub image endpoint and save it in the current workspace. Use this for image generation requests.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string", minLength: 1, description: "The image prompt." },
      model: { type: "string", description: "GPT Image model id, default gpt-image-2." },
      size: { type: "string", description: "Image size such as 1024x1024, 1536x1024, or auto." },
      quality: { type: "string", enum: ["low", "medium", "high", "auto"] },
      background: { type: "string", enum: ["transparent", "opaque", "auto"] },
      output_format: { type: "string", enum: ["png", "jpeg", "webp"] },
      filename: { type: "string", description: "Optional output filename; it is kept inside output/imagegen." }
    }
  }
};

export interface CodexImageGenerationResult {
  path: string;
  name: string;
  mimeType: string;
  content: string;
}

export function isCodexImageGenerationConfigured(request: CodexImageRequest): boolean {
  const configured = request.instance.providerOptions?.baseUrl;
  return Boolean(
    (typeof configured === "string" && configured.trim())
    || request.env?.OPENAI_BASE_URL?.trim()
    || request.env?.OPENAI_API_KEY?.trim()
    || request.env?.CODEX_API_KEY?.trim()
  );
}

/** Executes the AgentHub bridge used when Codex's host-only native tool is unavailable. */
export async function executeCodexImageGeneration(
  request: CodexImageRequest,
  argumentsValue: unknown
): Promise<CodexImageGenerationResult> {
  const input = asRecord(argumentsValue);
  const prompt = stringValue(input.prompt);
  if (!prompt) throw new Error("image_gen requires a non-empty prompt");

  const model = stringValue(input.model) ?? "gpt-image-2";
  if (!model.startsWith("gpt-image-")) throw new Error("image_gen model must be a GPT Image model");
  const size = stringValue(input.size) ?? "auto";
  const quality = stringValue(input.quality) ?? "medium";
  const background = stringValue(input.background);
  const outputFormat = normalizeFormat(input.output_format);
  if (background === "transparent" && model === "gpt-image-2") {
    throw new Error("gpt-image-2 does not support transparent output; use a chroma-key prompt or gpt-image-1.5 explicitly");
  }

  const payload: RecordValue = {
    model,
    prompt,
    n: 1,
    size,
    quality,
    output_format: outputFormat
  };
  if (background) payload.background = background;

  const response = await fetch(imageEndpoint(request), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...authorizationHeader(request)
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10 * 60_000)
  });
  const bodyText = await response.text();
  const body = parseJson(bodyText);
  if (!response.ok) {
    throw new Error(`Image API request failed (${response.status}): ${errorText(body, bodyText)}`);
  }

  const data = asRecord(body).data;
  const first = Array.isArray(data) ? asRecord(data[0]) : {};
  const base64 = stringValue(first.b64_json);
  const remoteUrl = stringValue(first.url);
  if (!base64 && !remoteUrl) throw new Error("Image API returned no image data");

  const bytes = base64
    ? Buffer.from(base64, "base64")
    : await downloadImage(remoteUrl!);
  if (!bytes.length) throw new Error("Image API returned an empty image");

  const output = await allocateOutputPath(request.cwd, input.filename, outputFormat);
  await writeFile(output.path, bytes, { flag: "wx" });
  return {
    path: output.path,
    name: output.name,
    mimeType: mimeType(outputFormat),
    content: `Image generated and saved to ${output.path}`
  };
}

function imageEndpoint(request: CodexImageRequest): string {
  const configured = request.instance.providerOptions?.baseUrl;
  const fromInstance = typeof configured === "string" && configured.trim() ? configured.trim() : undefined;
  const fromEnvironment = request.env?.OPENAI_BASE_URL?.trim();
  const apiKey = request.env?.OPENAI_API_KEY?.trim() || request.env?.CODEX_API_KEY?.trim();
  const baseUrl = (fromInstance ?? fromEnvironment ?? (apiKey ? "https://api.openai.com/v1" : undefined))?.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("image_gen needs a configured image API base URL or OPENAI_API_KEY");
  try {
    const url = new URL(`${baseUrl}/images/generations`);
    if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("unsupported protocol");
    return url.toString();
  } catch {
    throw new Error("image_gen received an invalid image API base URL");
  }
}

function authorizationHeader(request: CodexImageRequest): Record<string, string> {
  const apiKey = request.env?.OPENAI_API_KEY?.trim() || request.env?.CODEX_API_KEY?.trim();
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

async function downloadImage(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) throw new Error(`Image API image download failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

async function allocateOutputPath(
  cwd: string,
  requestedFilename: unknown,
  outputFormat: ImageFormat
): Promise<{ path: string; name: string }> {
  const outputDir = resolve(cwd, "output", "imagegen");
  await mkdir(outputDir, { recursive: true });
  const extension = outputFormat === "jpeg" ? ".jpg" : `.${outputFormat}`;
  const rawName = typeof requestedFilename === "string" && requestedFilename.trim()
    ? basename(requestedFilename.trim())
    : `generated-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`;
  const stem = (extname(rawName) ? rawName.slice(0, -extname(rawName).length) : rawName)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "generated-image";
  const candidate = join(outputDir, `${stem}${extension}`);
  const relativePath = relative(resolve(cwd), resolve(candidate));
  if (relativePath.startsWith("..") || resolve(relativePath) === resolve(".")) {
    throw new Error("image_gen output path escaped the workspace");
  }
  try {
    await stat(candidate);
    return allocateOutputPath(cwd, `${stem}-${randomUUID().slice(0, 8)}${extension}`, outputFormat);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { path: candidate, name: candidate.split(/[\\/]/).at(-1) ?? `${stem}${extension}` };
}

type ImageFormat = "png" | "jpeg" | "webp";

function normalizeFormat(value: unknown): ImageFormat {
  const normalized = typeof value === "string" ? value.toLowerCase() : "png";
  if (normalized === "jpg") return "jpeg";
  if (normalized === "png" || normalized === "jpeg" || normalized === "webp") return normalized;
  throw new Error("image_gen output_format must be png, jpeg, or webp");
}

function mimeType(format: ImageFormat): string {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function asRecord(value: unknown): RecordValue {
  if (typeof value === "string") {
    try { return asRecord(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === "object" ? value as RecordValue : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function errorText(body: unknown, fallback: string): string {
  const error = asRecord(asRecord(body).error);
  return stringValue(error.message) ?? stringValue(error.code) ?? fallback.slice(0, 500);
}
