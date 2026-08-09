import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rcedit } from "rcedit";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Packages the Tauri build as a portable ZIP. Unlike the Electron flow this
 * bundle ships NO Node.js runtime: the shell (Tauri/WebView2) and the Core
 * Daemon (Rust) are both native executables. Provider plugins are native
 * executables too and install into the user data directory at runtime; the
 * three first-party builds are bundled under plugins/ for manual install.
 *
 * Prerequisites (expected to already be built, or pass --build to build here):
 *   apps/desktop/src-tauri/target/release/nautilo.exe
 *   rust/target/x86_64-pc-windows-gnu/release/nautilo-core.exe
 *   rust/target/x86_64-pc-windows-gnu/release/agenthub-plugin-*.exe
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(repositoryRoot, "release");
const releaseName = "Nautilo-win32-x64";
let applicationDirectory = join(releaseRoot, releaseName);
let archivePath = join(releaseRoot, `${releaseName}.zip`);

const rustTargetDirectory = join(repositoryRoot, "rust", "target", "x86_64-pc-windows-gnu", "release");
const shellExecutable = join(repositoryRoot, "apps", "desktop", "src-tauri", "target", "release", "nautilo.exe");
const daemonExecutable = join(rustTargetDirectory, "nautilo-core.exe");
const pluginNames = ["agenthub-plugin-pi.exe", "agenthub-plugin-trae.exe", "agenthub-plugin-opencode.exe"];

function assertGeneratedTarget(target) {
  const path = relative(releaseRoot, resolve(target));
  if (path === "" || path.startsWith("..") || path.includes(":")) {
    throw new Error(`Refusing to modify a path outside the release directory: ${target}`);
  }
}

function replaceGeneratedTarget(target) {
  assertGeneratedTarget(target);
  rmSync(target, { recursive: true, force: true });
}

function isLockedPathError(error) {
  return error && typeof error === "object" && (error.code === "EPERM" || error.code === "EACCES");
}

function prepareReleaseTargets() {
  try {
    replaceGeneratedTarget(applicationDirectory);
    replaceGeneratedTarget(archivePath);
  } catch (error) {
    // A running portable app locks its own directory on Windows. Preserve that
    // release and create a fresh, runnable build rather than failing the package.
    if (!isLockedPathError(error)) throw error;
    const suffix = new Date().toISOString().replace(/[-:.TZ]/g, "");
    applicationDirectory = join(releaseRoot, `${releaseName}-${suffix}`);
    archivePath = join(releaseRoot, `${releaseName}-${suffix}.zip`);
    console.warn(`Existing release is locked; writing a new build to ${applicationDirectory}`);
    replaceGeneratedTarget(applicationDirectory);
    replaceGeneratedTarget(archivePath);
  }
}

function run(command, args, cwd) {
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", command, ...args], { cwd, stdio: "inherit", windowsHide: true, env: process.env })
    : spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

if (process.argv.includes("--build")) {
  // Renderer -> src-tauri/dist, then the Tauri shell and the Rust workspace.
  run("npx.cmd", ["vite", "build", "--config", "vite.tauri.config.mts"], join(repositoryRoot, "apps", "desktop"));
  run("cargo", ["build", "--release"], join(repositoryRoot, "apps", "desktop", "src-tauri"));
  run("cargo", ["build", "--release"], join(repositoryRoot, "rust"));
}

for (const required of [shellExecutable, daemonExecutable, ...pluginNames.map((name) => join(rustTargetDirectory, name))]) {
  if (!existsSync(required)) throw new Error(`Required build input is missing: ${required}`);
}

mkdirSync(releaseRoot, { recursive: true });
prepareReleaseTargets();
mkdirSync(applicationDirectory, { recursive: true });

const brandedExecutable = join(applicationDirectory, "Nautilo.exe");
copyFileSync(shellExecutable, brandedExecutable);
const iconSource = join(repositoryRoot, "apps", "desktop", "resources", "nautilo-icon.ico");
if (existsSync(iconSource)) {
  await rcedit(brandedExecutable, {
    icon: iconSource,
    "version-string": {
      CompanyName: "Nautilo",
      FileDescription: "Nautilo",
      InternalName: "Nautilo",
      OriginalFilename: "Nautilo.exe",
      ProductName: "Nautilo"
    },
    "file-version": "0.1.0",
    "product-version": "0.1.0"
  });
}

// The shell resolves the daemon next to itself (packaged layout).
copyFileSync(daemonExecutable, join(applicationDirectory, "nautilo-core.exe"));

// The Tauri shell links WebView2Loader.dll dynamically; the official bundler
// ships it next to the executable, so the portable bundle must too.
const webview2Loader = join(dirname(shellExecutable), "WebView2Loader.dll");
if (existsSync(webview2Loader)) {
  copyFileSync(webview2Loader, join(applicationDirectory, "WebView2Loader.dll"));
}

// Bundled for manual "install from local folder": plugins/<id>/ with the
// manifest + executable, the same self-contained layout install_local needs.
const pluginDirectory = join(applicationDirectory, "plugins");
for (const name of pluginNames) {
  const id = name.replace(/^agenthub-plugin-(.+)\.exe$/, "$1");
  const target = join(pluginDirectory, id);
  mkdirSync(target, { recursive: true });
  copyFileSync(join(rustTargetDirectory, name), join(target, name));
  const manifest = join(repositoryRoot, "rust", "plugins", id, "agenthub-plugin.json");
  if (!existsSync(manifest)) throw new Error(`Required plugin manifest is missing: ${manifest}`);
  copyFileSync(manifest, join(target, "agenthub-plugin.json"));
}

const rootPackage = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
writeFileSync(join(applicationDirectory, "PACKAGE-INFO.txt"), [
  `${rootPackage.description ?? "Nautilo"}`,
  `Version: ${rootPackage.version}`,
  "Runtime: Tauri 2 (WebView2) + nautilo-core (Rust)",
  "Node.js: not required",
  "Launch: Nautilo.exe"
].join("\r\n"));

const archive = spawnSync("tar.exe", ["-a", "-c", "-f", archivePath, "-C", releaseRoot, basename(applicationDirectory)], {
  cwd: repositoryRoot,
  stdio: "inherit",
  windowsHide: true
});
if (archive.status !== 0) throw new Error(`Creating the portable ZIP failed with exit code ${archive.status}`);

console.log(JSON.stringify({ applicationDirectory, archivePath }, null, 2));
