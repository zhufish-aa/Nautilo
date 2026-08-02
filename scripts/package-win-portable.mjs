import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rcedit } from "rcedit";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(repositoryRoot, "release");
const releaseName = "AgentHub-win32-x64";
let applicationDirectory = join(releaseRoot, releaseName);
let archivePath = join(releaseRoot, `${releaseName}.zip`);

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

function copyDirectory(source, target) {
  if (!existsSync(source)) throw new Error(`Required build input is missing: ${source}`);
  cpSync(source, target, { recursive: true, dereference: true });
}

const nodeVersion = process.versions.node.split(".").map(Number);
if (nodeVersion[0] < 22 || (nodeVersion[0] === 22 && nodeVersion[1] < 5)) {
  throw new Error(`AgentHub packaging requires Node.js 22.5 or newer; found ${process.versions.node}`);
}

mkdirSync(releaseRoot, { recursive: true });
prepareReleaseTargets();

const desktopRequire = createRequire(join(repositoryRoot, "apps", "desktop", "package.json"));
const electronExecutable = desktopRequire("electron");
const electronDistribution = dirname(electronExecutable);
copyDirectory(electronDistribution, applicationDirectory);

const originalExecutable = join(applicationDirectory, "electron.exe");
const brandedExecutable = join(applicationDirectory, "AgentHub.exe");
if (!existsSync(originalExecutable)) throw new Error(`Electron executable was not found: ${originalExecutable}`);
renameSync(originalExecutable, brandedExecutable);
const iconSource = join(repositoryRoot, "apps", "desktop", "resources", "agenthub-icon.ico");
if (!existsSync(iconSource)) throw new Error(`Application icon was not found: ${iconSource}`);
await rcedit(brandedExecutable, { icon: iconSource });

const resourcesDirectory = join(applicationDirectory, "resources");
rmSync(join(resourcesDirectory, "default_app.asar"), { force: true });

const desktopAppDirectory = join(resourcesDirectory, "app");
mkdirSync(desktopAppDirectory, { recursive: true });
copyDirectory(join(repositoryRoot, "apps", "desktop", "out"), join(desktopAppDirectory, "out"));
writeFileSync(join(desktopAppDirectory, "package.json"), JSON.stringify({
  name: "agenthub-desktop",
  version: "0.1.0",
  private: true,
  main: "out/main/index.js"
}, null, 2));
const windowIconSource = join(repositoryRoot, "apps", "desktop", "resources", "agenthub-icon-512.png");
if (!existsSync(windowIconSource)) throw new Error(`Window icon was not found: ${windowIconSource}`);
const windowIconDirectory = join(desktopAppDirectory, "resources");
mkdirSync(windowIconDirectory, { recursive: true });
copyFileSync(windowIconSource, join(windowIconDirectory, "agenthub-icon.png"));

const coreDaemonDirectory = join(resourcesDirectory, "core-daemon");
mkdirSync(coreDaemonDirectory, { recursive: true });
// The daemon runs under the bundled Node runtime, so it needs an isolated runtime
// dependency tree. `pnpm deploy --legacy` materializes workspace packages as well
// as transitive third-party dependencies; copying selected modules was incomplete.
const pnpmArguments = ["--filter", "@agenthub/core-daemon", "--prod", "deploy", "--legacy", coreDaemonDirectory];
const deployedDaemon = process.platform === "win32"
  ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", `pnpm.cmd --filter @agenthub/core-daemon --prod deploy --legacy ${relative(repositoryRoot, coreDaemonDirectory)}`], {
    cwd: repositoryRoot,
    stdio: "inherit",
    windowsHide: true
  })
  : spawnSync("pnpm", pnpmArguments, {
    cwd: repositoryRoot,
    stdio: "inherit",
    windowsHide: true
  });
if (deployedDaemon.error) throw deployedDaemon.error;
if (deployedDaemon.status !== 0) {
  throw new Error(`Deploying the Core Daemon runtime failed with exit code ${deployedDaemon.status}`);
}

const nodeRuntimeDirectory = join(resourcesDirectory, "node");
mkdirSync(nodeRuntimeDirectory, { recursive: true });
cpSync(process.execPath, join(nodeRuntimeDirectory, "node.exe"));
writeFileSync(join(nodeRuntimeDirectory, "README.txt"), [
  `Bundled Node.js runtime: ${process.version}`,
  "This runtime is used only by the local AgentHub Core Daemon.",
  "Before redistributing this package, include the official Node.js license and third-party notices."
].join("\r\n"));

const rootPackage = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
writeFileSync(join(applicationDirectory, "PACKAGE-INFO.txt"), [
  `${rootPackage.description ?? "AgentHub"}`,
  `Version: ${rootPackage.version}`,
  `Electron: ${desktopRequire("electron/package.json").version}`,
  `Node runtime: ${process.version}`,
  "Launch: AgentHub.exe"
].join("\r\n"));

const archive = spawnSync("tar.exe", ["-a", "-c", "-f", archivePath, "-C", releaseRoot, basename(applicationDirectory)], {
  cwd: repositoryRoot,
  stdio: "inherit",
  windowsHide: true
});
if (archive.status !== 0) throw new Error(`Creating the portable ZIP failed with exit code ${archive.status}`);

console.log(JSON.stringify({ applicationDirectory, archivePath }, null, 2));
