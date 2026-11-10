/** Model lists are untrusted provider payloads, including when Content-Length is absent or compressed. */
export const MAX_MODEL_RESPONSE_BYTES = 8 * 1024 * 1024;
export class ModelResponseLimitError extends Error {
  constructor() { super("Model discovery response exceeds the 8 MiB limit"); }
}
export interface ModelResponseBudget { remainingBytes: number; }

/** A shared budget also bounds accumulated pages, not just individual responses. */
export async function readModelResponseJson(
  response: Response,
  budget: ModelResponseBudget = { remainingBytes: MAX_MODEL_RESPONSE_BYTES }
): Promise<unknown> {
  const limit = Math.min(MAX_MODEL_RESPONSE_BYTES, budget.remainingBytes);
  if (limit < 0 || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new ModelResponseLimitError();
  }
  if (!response.body) throw new Error("Model discovery returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      budget.remainingBytes -= value.byteLength;
      if (size > limit) throw new ModelResponseLimitError();
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("Model discovery returned invalid JSON"); }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
