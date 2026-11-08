import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prepares the platform-specific resources that electron-builder places under
 * the packaged app's resources/ directory:
 *
 *   <staging>/core-daemon/nautilo-core.exe  — Rust core daemon (replaces the
 *                                             former TS daemon + bundled Node)
 *   <staging>/plugins/<id>/                 — native provider plugins for
 *                                             manual "install from local folder"
 *
 * Run this on the TARGET platform (each CI runner runs its own copy), because
 * the executables are platform/arch specific.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stagingDirectory = resolve(repositoryRoot, process.argv[2] ?? "build/packaged");

if (!relative(repositoryRoot, stagingDirectory).startsWith("build")) {
  throw new Error(`Refusing to write outside the build directory: ${stagingDirectory}`);
}

rmSync(stagingDirectory, { recursive: true, force: true });
mkdirSync(stagingDirectory, { recursive: true });

// The Rust toolchain is pinned to x86_64-pc-windows-gnu with the repository's
// own mingw; make sure cargo can find the linker without relying on the
// caller's environment.
const mingwBin = join(repositoryRoot, ".toolchains", "mingw64", "bin");
const env = { ...process.env, PATH: `${mingwBin};${process.env.PATH ?? ""}` };

function run(command, args, cwd) {
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", command, ...args], { cwd, env, stdio: "inherit", windowsHide: true })
    : spawnSync(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

// Daemon + first-party provider plugins, all release executables.
run("cargo", ["build", "--release", "-p", "nautilo-core"], join(repositoryRoot, "rust"));
run("cargo", ["build", "--release", "-p", "agenthub-plugin-commandcode", "-p", "agenthub-plugin-pi", "-p", "agenthub-plugin-trae", "-p", "agenthub-plugin-opencode", "-p", "agenthub-plugin-omp", "-p", "agenthub-plugin-deepseek", "-p", "agenthub-plugin-codex-plugins"], join(repositoryRoot, "rust"));

const profileDirectory = join(repositoryRoot, "rust", "target", "x86_64-pc-windows-gnu", "release");
const daemonExecutable = join(profileDirectory, "nautilo-core.exe");
if (!existsSync(daemonExecutable)) throw new Error(`Rust daemon build output missing: ${daemonExecutable}`);

const coreDaemonDirectory = join(stagingDirectory, "core-daemon");
mkdirSync(coreDaemonDirectory, { recursive: true });
copyFileSync(daemonExecutable, join(coreDaemonDirectory, "nautilo-core.exe"));

// Bundled for manual "install from local folder": plugins/<id>/ carrying the
// manifest + native executable, mirroring the Tauri package layout.
const pluginsDirectory = join(stagingDirectory, "plugins");
for (const id of ["opencode", "trae", "pi", "omp", "commandcode", "deepseek", "codex-plugins"]) {
  const source = join(repositoryRoot, "rust", "plugins", id);
  const manifest = join(source, "agenthub-plugin.json");
  const exe = join(profileDirectory, `agenthub-plugin-${id}.exe`);
  if (!existsSync(manifest) || !existsSync(exe)) {
    console.warn(`skip plugin ${id}: manifest or executable missing`);
    continue;
  }
  const target = join(pluginsDirectory, id);
  mkdirSync(target, { recursive: true });
  copyFileSync(manifest, join(target, "agenthub-plugin.json"));
  copyFileSync(exe, join(target, `agenthub-plugin-${id}.exe`));
}

console.log(JSON.stringify({ stagingDirectory }, null, 2));
