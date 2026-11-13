import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { workspace } from "./rust-build.mjs";
import { nativePackaging } from "./native-packaging.mjs";

const { platformKey, executableExtension, plugins } = nativePackaging();
const version = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")).version;
if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME?.startsWith("v") && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error(`Release tag must match package version v${version}`);
}
const output = join(workspace, "release");
mkdirSync(output, { recursive: true });
const descriptions = {
  opencode: ["接入 OpenCode CLI，保留原生会话和工具。", "Use OpenCode CLI with native sessions and tools."],
  trae: ["接入开源 trae-agent 和 Trae CLI。", "Use open-source trae-agent and Trae CLI."],
  pi: ["接入 Pi coding agent，支持会话恢复与原生扩展。", "Use Pi coding agent with session resume and native extensions."],
  omp: ["接入 Oh My Pi，保留原生会话和扩展。", "Use Oh My Pi with native sessions and extensions."],
  commandcode: ["接入 Command Code CLI。", "Use Command Code CLI."],
  deepseek: ["接入 DeepSeek Harness，支持原生动态模式与 PTC。", "Use DeepSeek Harness with native dynamic modes and PTC."],
  "codex-plugins": ["管理 Codex 原生插件与授权。", "Manage native Codex plugins and authorization."],
  antigravity: ["接入 Google Antigravity，支持官方账号登录与原生 ACP 会话。", "Use Google Antigravity with official sign-in and native ACP sessions."]
};
const entries = [];
for (const id of plugins) {
  const root = join(workspace, "build", "packaged", "plugins", id);
  const manifest = JSON.parse(readFileSync(join(root, "agenthub-plugin.json"), "utf8"));
  if (manifest.version !== version) throw new Error(`Plugin ${id} version must be ${version}`);
  if (!existsSync(join(root, `${manifest.main}${executableExtension}`))) throw new Error(`Plugin ${id} binary is missing`);
  const filename = `nautilo-plugin-${id}-${version}-${platformKey}.tgz`;
  const tar = spawnSync("tar", ["-czf", filename, "-C", relative(output, join(root, "..")), id], { cwd: output, stdio: "inherit", windowsHide: true });
  if (tar.error) throw tar.error;
  if (tar.status !== 0) throw new Error(`Packaging ${id} failed (${tar.status})`);
  const sha256 = createHash("sha256").update(readFileSync(join(output, filename))).digest("hex");
  entries.push({
    id, name: manifest.descriptor.name, vendor: manifest.descriptor.vendor, version,
    minAppVersion: version, description: { "zh-CN": descriptions[id][0], "en-US": descriptions[id][1] },
    tarball: `https://github.com/${process.env.GITHUB_REPOSITORY ?? "zhufish-aa/Nautilo"}/releases/download/v${version}/${filename}`, sha256
  });
}
writeFileSync(join(output, `plugins-${platformKey}.json`), `${JSON.stringify({ platform: platformKey, plugins: entries }, null, 2)}\n`);
console.log(`Packaged ${entries.length} native plugins for ${platformKey}`);
