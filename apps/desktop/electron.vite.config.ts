import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import { markdownEntitiesPlugin } from "./markdown-worker.vite";
import { serialWorkerBuilds } from "./worker-build.vite";

const sourcemap = process.env.NAUTILO_BUILD_SOURCEMAP !== "0";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      sourcemap
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
