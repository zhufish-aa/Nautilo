import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(repositoryRoot, "release");
const applicationDirectory = join(releaseRoot, "AgentHub-win32-x64");
const archivePath = join(releaseRoot, "AgentHub-win32-x64.zip");

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

function copyDirectory(source, target) {
  if (!existsSync(source)) throw new Error(`Required build input is missing: ${source}`);
  cpSync(source, target, { recursive: true, dereference: true });
}

function copyWorkspacePackage(packageName) {
  const source = join(repositoryRoot, "packages", packageName);
  const target = join(applicationDirectory, "resources", "core-daemon", "node_modules", "@agenthub", packageName);
  mkdirSync(target, { recursive: true });
  cpSync(join(source, "package.json"), join(target, "package.json"));
  copyDirectory(join(source, "dist"), join(target, "dist"));
}

const nodeVersion = process.versions.node.split(".").map(Number);
if (nodeVersion[0] < 22 || (nodeVersion[0] === 22 && nodeVersion[1] < 5)) {
  throw new Error(`AgentHub packaging requires Node.js 22.5 or newer; found ${process.versions.node}`);
}

replaceGeneratedTarget(applicationDirectory);
replaceGeneratedTarget(archivePath);
mkdirSync(releaseRoot, { recursive: true });

const desktopRequire = createRequire(join(repositoryRoot, "apps", "desktop", "package.json"));
const electronExecutable = desktopRequire("electron");
const electronDistribution = dirname(electronExecutable);
copyDirectory(electronDistribution, applicationDirectory);

const originalExecutable = join(applicationDirectory, "electron.exe");
const brandedExecutable = join(applicationDirectory, "AgentHub.exe");
if (!existsSync(originalExecutable)) throw new Error(`Electron executable was not found: ${originalExecutable}`);
renameSync(originalExecutable, brandedExecutable);

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

const coreDaemonDirectory = join(resourcesDirectory, "core-daemon");
mkdirSync(coreDaemonDirectory, { recursive: true });
copyDirectory(join(repositoryRoot, "packages", "core-daemon", "dist"), coreDaemonDirectory);
writeFileSync(join(coreDaemonDirectory, "package.json"), JSON.stringify({
  name: "agenthub-core-daemon-runtime",
  version: "0.1.0",
  private: true,
  type: "module"
}, null, 2));

copyWorkspacePackage("domain");
copyWorkspacePackage("event-protocol");
copyWorkspacePackage("schemas");

const nodePtySource = join(repositoryRoot, "packages", "core-daemon", "node_modules", "node-pty");
if (existsSync(nodePtySource)) {
  copyDirectory(nodePtySource, join(coreDaemonDirectory, "node_modules", "node-pty"));
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

const archive = spawnSync("tar.exe", ["-a", "-c", "-f", archivePath, "-C", releaseRoot, "AgentHub-win32-x64"], {
  cwd: repositoryRoot,
  stdio: "inherit",
  windowsHide: true
});
if (archive.status !== 0) throw new Error(`Creating the portable ZIP failed with exit code ${archive.status}`);

console.log(JSON.stringify({ applicationDirectory, archivePath }, null, 2));
