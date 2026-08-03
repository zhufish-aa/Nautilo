import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prepares the platform-specific resources that electron-builder places under
 * the packaged app's resources/ directory:
 *
 *   <staging>/core-daemon  — isolated runtime dependency tree for the daemon
 *   <staging>/node         — a Node.js runtime matching the current platform
 *
 * Run this on the TARGET platform (each CI runner runs its own copy), because
 * both the deployed native modules (node-pty) and the Node binary are
 * platform/arch specific.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stagingDirectory = resolve(repositoryRoot, process.argv[2] ?? "build/packaged");

if (!relative(repositoryRoot, stagingDirectory).startsWith("build")) {
  throw new Error(`Refusing to write outside the build directory: ${stagingDirectory}`);
}

const nodeVersion = process.versions.node.split(".").map(Number);
if (nodeVersion[0] < 22 || (nodeVersion[0] === 22 && nodeVersion[1] < 5)) {
  throw new Error(`Nautilo packaging requires Node.js 22.5 or newer; found ${process.versions.node}`);
}

rmSync(stagingDirectory, { recursive: true, force: true });
mkdirSync(stagingDirectory, { recursive: true });

// The daemon runs under the bundled Node runtime, so it needs an isolated
// runtime dependency tree. `pnpm deploy --legacy` materializes workspace
// packages as well as transitive third-party dependencies.
const coreDaemonDirectory = join(stagingDirectory, "core-daemon");
const deployedDaemon = process.platform === "win32"
  ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", `pnpm.cmd --filter @agenthub/core-daemon --prod deploy --legacy ${relative(repositoryRoot, coreDaemonDirectory)}`], {
    cwd: repositoryRoot,
    stdio: "inherit",
    windowsHide: true
  })
  : spawnSync("pnpm", ["--filter", "@agenthub/core-daemon", "--prod", "deploy", "--legacy", coreDaemonDirectory], {
    cwd: repositoryRoot,
    stdio: "inherit",
    windowsHide: true
  });
if (deployedDaemon.error) throw deployedDaemon.error;
if (deployedDaemon.status !== 0) {
  throw new Error(`Deploying the Core Daemon runtime failed with exit code ${deployedDaemon.status}`);
}

const nodeRuntimeDirectory = join(stagingDirectory, "node");
mkdirSync(nodeRuntimeDirectory, { recursive: true });
cpSync(process.execPath, join(nodeRuntimeDirectory, process.platform === "win32" ? "node.exe" : "node"));
writeFileSync(join(nodeRuntimeDirectory, "README.txt"), [
  `Bundled Node.js runtime: ${process.version}`,
  "This runtime is used only by the local Nautilo Core Daemon.",
  "Before redistributing this package, include the official Node.js license and third-party notices."
].join("\n"));

console.log(JSON.stringify({ stagingDirectory }, null, 2));
