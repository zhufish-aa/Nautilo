// Copies the built native plugin executables from the cargo target directory
// into each plugin's source directory, so rust/plugins/<id>/ is a
// self-contained installable plugin package (agenthub-plugin.json + exe).
// Usage: node scripts/sync-rust-plugins.mjs [--release]
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.argv.includes("--release") ? "release" : "debug";
const targetDir = join(process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : join(root, "rust", "target"), "x86_64-pc-windows-gnu", profile);
const plugins = ["opencode", "trae", "pi", "omp", "commandcode", "deepseek", "codex-plugins"];

let copied = 0;
for (const id of plugins) {
  const exe = join(targetDir, `agenthub-plugin-${id}.exe`);
  const destination = join(root, "rust", "plugins", id, `agenthub-plugin-${id}.exe`);
  if (!existsSync(exe)) {
    console.warn(`skip ${id}: ${exe} not built yet`);
    continue;
  }
  copyFileSync(exe, destination);
  copied += 1;
}
console.log(`synced ${copied}/${plugins.length} plugin executables (${profile})`);
