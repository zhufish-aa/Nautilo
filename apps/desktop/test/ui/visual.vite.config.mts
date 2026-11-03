import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { resolve } from "node:path";

/** Independent QA entry; production builds never import this configuration or fixture. */
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: { alias: [
    { find: /^.*\/lib\/bridge(?:\.ts)?$/, replacement: resolve(__dirname, "visual-bridge.ts") },
    { find: "@", replacement: resolve(__dirname, "../../src/renderer/src") }
  ] },
  server: { host: "127.0.0.1", port: 4179, strictPort: true, fs: { allow: [resolve(__dirname, "../../../..")] } },
  build: { outDir: resolve(__dirname, "../../../../.qa/visual-dist"), emptyOutDir: true, rollupOptions: { input: resolve(__dirname, "visual.html") } }
});
