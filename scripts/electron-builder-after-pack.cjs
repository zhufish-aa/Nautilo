const { cpSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");

/**
 * electron-builder afterPack hook: copies the deployed Core Daemon (including
 * its node_modules) into the packaged app's resources directory.
 *
 * extraResources cannot be used for this — electron-builder skips directories
 * named node_modules when expanding FileSets, and the daemon is dead without
 * its dependencies.
 */
module.exports = async function afterPack(context) {
  const repositoryRoot = resolve(__dirname, "..");
  const source = join(repositoryRoot, "build", "packaged", "core-daemon");
  if (!existsSync(join(source, "node_modules"))) {
    throw new Error(`Deployed Core Daemon is missing node_modules: ${source}. Run scripts/prepare-packaged-resources.mjs first.`);
  }
  const resourcesDirectory = context.electronPlatformName === "darwin"
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : join(context.appOutDir, "resources");
  const target = join(resourcesDirectory, "core-daemon");
  // Only runtime files: src/, test/, tsconfig and tsbuildinfo are build inputs.
  for (const entry of ["dist", "node_modules", "package.json"]) {
    // dereference: pnpm deploy may link packages into a virtual store.
    cpSync(join(source, entry), join(target, entry), { recursive: true, dereference: true });
  }
  console.log(`afterPack: copied Core Daemon runtime to ${target}`);
};
