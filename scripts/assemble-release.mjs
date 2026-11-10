import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { nativeTargets, nativePlugins } from "./native-packaging.mjs";
import { workspace } from "./rust-build.mjs";

const output = join(workspace, "release");
const version = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")).version;
const entries = new Map();
for (const platform of Object.keys(nativeTargets)) {
  const index = JSON.parse(readFileSync(join(output, `plugins-${platform}.json`), "utf8"));
  if (index.platform !== platform || index.plugins.length !== nativePlugins.length) throw new Error(`Incomplete plugin index: ${platform}`);
  for (const plugin of index.plugins) {
    if (!nativePlugins.includes(plugin.id) || plugin.version !== version) throw new Error(`Unexpected plugin: ${plugin.id}`);
    const filename = new URL(plugin.tarball).pathname.split("/").pop();
    const digest = createHash("sha256").update(readFileSync(join(output, filename))).digest("hex");
    if (digest !== plugin.sha256) throw new Error(`Plugin checksum mismatch: ${filename}`);
    const entry = entries.get(plugin.id) ?? { ...plugin, platforms: {} };
    entry.platforms[platform] = { tarball: plugin.tarball, sha256: plugin.sha256 };
    if (platform === "win32-x64") Object.assign(entry, { tarball: plugin.tarball, sha256: plugin.sha256 });
    entries.set(plugin.id, entry);
  }
}
const registry = { plugins: [...entries.values()] };
writeFileSync(join(output, "plugins-registry.json"), `${JSON.stringify(registry, null, 2)}\n`);
const assets = readdirSync(output).filter(name => /^(Nautilo-|nautilo-plugin-)/.test(name) && statSync(join(output, name)).isFile());
const checksums = [...assets, "plugins-registry.json"].sort().map(name => `${createHash("sha256").update(readFileSync(join(output, name))).digest("hex")}  ${name}`);
writeFileSync(join(output, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);
console.log(`Verified ${registry.plugins.length} plugins across ${Object.keys(nativeTargets).length} platforms; ${assets.length} release assets`);
