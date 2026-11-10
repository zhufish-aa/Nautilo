import { createRequire } from "node:module";
import type { DepOptimizationOptions, Plugin } from "vite";

/** The Markdown entity decoder's browser export calls document.createElement.
 * Its official default entry is DOM-free (also the package's worker export).
 * Resolve only this dependency through Node's default export conditions, not
 * every renderer dependency through a global `worker` condition. Applying the
 * same precise resolution in dev/main and worker builds keeps behavior equal. */
export function markdownEntitiesPlugin(): Plugin {
  const optimizeDeps: DepOptimizationOptions = {
    esbuildOptions: {
      plugins: [{
        name: "markdown-dom-free-entities",
        setup(build) {
          // Vite's dev dependency prebundler does not run resolveId hooks.
          // It must choose the same DOM-free entry as the production worker.
          build.onResolve({ filter: /^decode-named-character-reference$/ }, ({ importer, path }) => {
            return importer ? { path: createRequire(importer).resolve(path) } : undefined;
          });
        }
      }]
    }
  };
  return {
    name: "markdown-dom-free-entities",
    enforce: "pre",
    config: () => ({ optimizeDeps }),
    resolveId(source, importer) {
      if (source === "decode-named-character-reference" && importer) return createRequire(importer).resolve(source);
      return null;
    }
  };
}
