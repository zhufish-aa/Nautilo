import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import { markdownEntitiesPlugin } from "./markdown-worker.vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      sourcemap: true
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      sourcemap: true
    }
  },
  renderer: {
    plugins: [react(), tailwindcss(), markdownEntitiesPlugin()],
    worker: { plugins: () => [markdownEntitiesPlugin()] },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src")
      }
    },
    build: {
      outDir: "out/renderer",
      sourcemap: true
    }
  }
});
