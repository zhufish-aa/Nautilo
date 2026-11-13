import type { IncomingMessage, ServerResponse } from "node:http";

// Wire JSON is validated at this boundary, before native runtime execution.
export type Json = Record<string, any>;
export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function readRequest(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.from(raw);
    size += chunk.length;
    if (size > 20 * 1024 * 1024)
      throw new RelayError(413, "REQUEST_TOO_LARGE", "Request exceeds 20 MiB");
    chunks.push(chunk);
  }
  let body: Json;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RelayError(400, "INVALID_JSON", "Expected a JSON request");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new RelayError(400, "INVALID_REQUEST", "Expected an object");
  if (
    !Array.isArray(body.messages) ||
    !body.messages.length ||
    body.messages.length > 2000 ||
    body.messages.some((m: Json) => !m || typeof m.role !== "string")
  ) {
    throw new RelayError(
      400,
      "INVALID_MESSAGES",
      "Expected a non-empty messages array",
    );
  }
  const tools = body.tools ?? [];
  if (
    !Array.isArray(tools) ||
    tools.length > 256 ||
    tools.some(
      (t: Json) =>
        t?.type !== "function" ||
        typeof t.function?.name !== "string" ||
        !t.function.name,
    )
  ) {
    throw new RelayError(
      400,
      "INVALID_CALLER_TOOLS",
      "Expected up to 256 named function tools",
    );
  }
  return body;
}

export function respondJson(
  res: ServerResponse,
  status: number,
  value: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
export function respondError(res: ServerResponse, failure: unknown): void {
  const code =
    failure instanceof RelayError ? failure.code : "NATIVE_ACCOUNT_ERROR";
  const status = failure instanceof RelayError ? failure.status : 502;
  const message = failure instanceof Error ? failure.message : String(failure);
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent)
    res.end(
      `data: ${JSON.stringify({ error: { code, message } })}\n\ndata: [DONE]\n\n`,
    );
  else respondJson(res, status, { error: { code, message } });
}
