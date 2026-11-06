import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

/** Inherit resource files, not account credentials or conversation history. */
export function inheritNativeResources(source: string, destination: string, names: readonly string[]): void {
  if (normalize(source) === normalize(destination)) return;
  const manifest = join(destination, ".nautilo-inherited-resources.json");
  const previous: Record<string, string> = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : {};
  const current: Record<string, string> = {};
  const files = new Map<string, Buffer>();
  const collect = (path: string, relative: string, ancestors = new Set<string>()) => {
    let canonical: string;
    try { canonical = realpathSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && lstatSync(path).isSymbolicLink()) return;
      throw new Error(`Unable to resolve native resource: ${path}`, { cause:error });
    }
    if (ancestors.has(canonical)) throw new Error(`Native resource contains a directory cycle: ${path}`);
    ancestors.add(canonical);
    if (statSync(path).isDirectory()) for (const name of readdirSync(path)) collect(join(path, name), join(relative, name), ancestors);
    else files.set(relative, readFileSync(path));
    ancestors.delete(canonical);
  };
  for (const name of names) if (existsSync(join(source, name))) collect(join(source, name), name);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const [relative, bytes] of files) {
    const target = join(destination, relative);
    current[relative] = createHash("sha256").update(bytes).digest("hex");
    if (!existsSync(target) || !readFileSync(target).equals(bytes)) {
      const parent = join(target, "..");
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: 0o600 });
    }
  }
  for (const [relative, hash] of Object.entries(previous)) {
    if (isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === ".." || !part)) continue;
    const target = join(destination, relative);
    if (!(relative in current) && existsSync(target) && createHash("sha256").update(readFileSync(target)).digest("hex") === hash) unlinkSync(target);
  }
  writeFileSync(manifest, JSON.stringify(current), { mode: 0o600 });
}
