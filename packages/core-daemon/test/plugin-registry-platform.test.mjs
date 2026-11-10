import test from "node:test";
import assert from "node:assert/strict";
import { selectRegistryPackage } from "../dist/runtime/plugins/plugin-service.js";

const entry = { id: "pi", tarball: "windows.tgz", sha256: "windows", platforms: {
  "win32-x64": { tarball: "windows.tgz", sha256: "windows" },
  "darwin-arm64": { tarball: "mac.tgz", sha256: "mac" },
  "linux-x64": { tarball: "linux.tgz", sha256: "linux" }
} };
test("marketplace selects the native package with its matching checksum", () => {
  assert.equal(selectRegistryPackage(entry, "darwin", "arm64").tarball, "mac.tgz");
  assert.equal(selectRegistryPackage(entry, "linux", "x64").sha256, "linux");
  assert.equal(selectRegistryPackage(entry, "win32", "x64").tarball, "windows.tgz");
});
test("unsupported native platforms never fall back to a Windows binary", () => {
  assert.equal(selectRegistryPackage(entry, "linux", "arm64"), undefined);
  const legacy = { id: "legacy", tarball: "legacy.tgz" };
  assert.equal(selectRegistryPackage(legacy, "linux", "x64"), legacy);
});
