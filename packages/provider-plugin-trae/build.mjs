import { build } from "esbuild";

// Ship one installable plugin file, including its native YAML parser.
await build({
  entryPoints: ["src/index.ts"], outfile: "dist/index.js", bundle: true,
  platform: "node", format: "esm", target: "node22",
  loader: { ".py": "text" },
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }
});
