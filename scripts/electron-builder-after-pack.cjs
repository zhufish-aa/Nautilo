const { rmSync } = require("node:fs");
const { join } = require("node:path");

/**
 * electron-builder afterPack hook. The Core Daemon and plugins now ship as
 * native executables via extraResources (see electron-builder.yml), so this
 * hook only strips binaries the app never loads.
 */
module.exports = async function afterPack(context) {
  // Software Vulkan/WebGPU (~7 MB). The renderer never touches WebGL/WebGPU
  // (verified: no getContext("webgl") anywhere), and Chromium hardware
  // acceleration goes through ANGLE/D3D on Windows — these are never loaded.
  if (context.electronPlatformName === "win32") {
    for (const entry of ["vk_swiftshader.dll", "vk_swiftshader_icd.json", "vulkan-1.dll"]) {
      rmSync(join(context.appOutDir, entry), { force: true });
    }
    console.log("afterPack: removed unused Vulkan/SwiftShader binaries");
  }
};
