import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { nativePackaging } from "./native-packaging.mjs";

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

const relativeStaging = relative(join(repositoryRoot, "build"), stagingDirectory);
if (!relativeStaging || relativeStaging === ".." || relativeStaging.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativeStaging)) {
  throw new Error(`Refusing to write outside the build directory: ${stagingDirectory}`);
}

rmSync(stagingDirectory, { recursive: true, force: true });
mkdirSync(stagingDirectory, { recursive: true });

const { env, target, targetDirectory, executableExtension, plugins } = nativePackaging();

function run(command, args, cwd) {
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", command, ...args], { cwd, env, stdio: "inherit", windowsHide: true })
    : spawnSync(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

// Daemon + first-party provider plugins, all release executables.
run("cargo", ["build", "--release", "--locked", "--workspace", "--target", target], join(repositoryRoot, "rust"));

const profileDirectory = join(targetDirectory, target, "release");
const daemonName = `nautilo-core${executableExtension}`;
const daemonExecutable = join(profileDirectory, daemonName);
if (!existsSync(daemonExecutable)) throw new Error(`Rust daemon build output missing: ${daemonExecutable}`);

const coreDaemonDirectory = join(stagingDirectory, "core-daemon");
mkdirSync(coreDaemonDirectory, { recursive: true });
copyFileSync(daemonExecutable, join(coreDaemonDirectory, daemonName));
if (process.platform !== "win32") chmodSync(join(coreDaemonDirectory, daemonName), 0o755);

// Bundled for manual "install from local folder": plugins/<id>/ carrying the
// manifest + native executable, mirroring the Tauri package layout.
const pluginsDirectory = join(stagingDirectory, "plugins");
for (const id of plugins) {
  const source = join(repositoryRoot, "rust", "plugins", id);
  const manifest = join(source, "agenthub-plugin.json");
  const executableName = `agenthub-plugin-${id}${executableExtension}`;
  const exe = join(profileDirectory, executableName);
  if (!existsSync(manifest) || !existsSync(exe)) {
    throw new Error(`Required plugin ${id} is missing its manifest or executable`);
  }
  const target = join(pluginsDirectory, id);
  mkdirSync(target, { recursive: true });
  copyFileSync(manifest, join(target, "agenthub-plugin.json"));
  copyFileSync(exe, join(target, executableName));
  if (process.platform !== "win32") chmodSync(join(target, executableName), 0o755);
}

console.log(JSON.stringify({ stagingDirectory }, null, 2));
