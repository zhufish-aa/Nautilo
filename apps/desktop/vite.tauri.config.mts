import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { resolve } from "node:path";
import { markdownEntitiesPlugin } from "./markdown-worker.vite";
import { serialWorkerBuilds } from "./worker-build.vite";

/**
 * Standalone renderer build for the Tauri shell. Mirrors the `renderer`
 * section of electron.vite.config.ts, emitting into src-tauri/dist which
 * tauri.conf.json references as frontendDist.
 */
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react(), tailwindcss(), markdownEntitiesPlugin()],
  worker: { plugins: (chain:string[]=[]) => [markdownEntitiesPlugin(),serialWorkerBuilds(chain)] },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer/src")
    }
  },
  build: {
    outDir: resolve(__dirname, "src-tauri/dist"),
    emptyOutDir: true,
    sourcemap: true
  }
});
