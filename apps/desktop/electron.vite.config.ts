import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import { isBuiltin } from "node:module";
import type { Plugin } from "vite";
import { markdownEntitiesPlugin } from "./markdown-worker.vite";
import { serialWorkerBuilds } from "./worker-build.vite";

const sourcemap = process.env.NAUTILO_BUILD_SOURCEMAP !== "0";

// Packaged apps intentionally ship no node_modules. Fail the build if a
// runtime import would rely on the developer checkout or the user's machine.
function selfContainedRuntime(): Plugin {
  return {
    name: "nautilo:self-contained-runtime",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const name of [...output.imports, ...output.dynamicImports]) {
          if (bundle[name] || name === "electron" || isBuiltin(name)) continue;
          this.error(`Unbundled desktop runtime dependency: ${name} (imported by ${output.fileName})`);
        }
      }
    }
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["ws"] }), selfContainedRuntime()],
    build: {
      outDir: "out/main",
      sourcemap,
      // ws catches missing optional native accelerators and uses its JS
      // implementation. Keep real require() failures instead of Vite's empty
      // optional-peer shim, which otherwise breaks masked WebSocket frames.
      rollupOptions: { external: ["bufferutil", "utf-8-validate"] }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), selfContainedRuntime()],
    build: {
      outDir: "out/preload",
      sourcemap
    }
  },
  renderer: {
    plugins: [react(), tailwindcss(), markdownEntitiesPlugin()],
    worker: { plugins: (chain:string[]=[]) => [markdownEntitiesPlugin(),serialWorkerBuilds(chain)] },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src")
      }
    },
    build: {
      outDir: "out/renderer",
      sourcemap
    }
  }
});
