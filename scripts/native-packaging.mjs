import { resolve, join } from "node:path";
import { rustEnvironment, workspace } from "./rust-build.mjs";

export const nativePlugins = ["opencode", "trae", "pi", "omp", "commandcode", "deepseek", "codex-plugins", "antigravity"];
export const nativeTargets = {
  "win32-x64": "x86_64-pc-windows-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu"
};

export function nativePackaging(platform = process.platform, arch = process.arch) {
  const platformKey = `${platform}-${arch}`;
  const target = nativeTargets[platformKey];
  if (!target) throw new Error(`Unsupported release platform: ${platformKey}`);
  const env = rustEnvironment();
  if (env.NAUTILO_RUST_TARGET && env.NAUTILO_RUST_TARGET !== target) {
    throw new Error(`Rust target ${env.NAUTILO_RUST_TARGET} does not match ${platformKey} (${target})`);
  }
  return {
    env, target, platformKey, plugins: nativePlugins,
    executableExtension: platform === "win32" ? ".exe" : "",
    targetDirectory: env.CARGO_TARGET_DIR ? resolve(workspace, env.CARGO_TARGET_DIR) : join(workspace, "rust", "target")
  };
}
