import { createRequire } from "node:module";
import type { Plugin } from "vite";

/** The Markdown entity decoder's browser export calls document.createElement.
 * Its official default entry is DOM-free (also the package's worker export).
 * Resolve only this dependency through Node's default export conditions, not
 * every renderer dependency through a global `worker` condition. Applying the
 * same precise resolution in dev/main and worker builds keeps behavior equal. */
export function markdownEntitiesPlugin(): Plugin {
  return {
    name: "markdown-dom-free-entities",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "decode-named-character-reference" && importer) return createRequire(importer).resolve(source);
      return null;
    }
  };
}
