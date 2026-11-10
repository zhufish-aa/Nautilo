import { parseMarkdownFragments } from "./markdown-parse";

// No DOM, app stores, privileged bridge, or user-source evaluation in this
// worker. It uses the same Markdown/GFM parser as the synchronous fallback.
self.onmessage = (event: MessageEvent<{ id: number; source: string }>): void => {
  const { id, source } = event.data;
  try { self.postMessage({ id, fragments: parseMarkdownFragments(source) }); }
  catch { self.postMessage({ id, error: "Markdown parsing failed" }); }
};
