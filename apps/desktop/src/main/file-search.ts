import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Directories that never contain user code worth searching. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "release", "coverage", "build",
  ".idea", ".vscode", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache",
  "target", "__pycache__", ".pytest_cache", ".svn", ".hg", "vendor", "tmp", "temp"
]);

const MAX_DEPTH = 8;
const MAX_MATCHES = 50;

/**
 * Bounded fallback search for chat file references that did not resolve
 * directly against the project root. Bare filenames match by basename
 * (case-insensitive); partial relative paths match by path suffix.
 * Runs only on demand (a chip click), never builds an index.
 */
export async function searchFileReferences(queryPath: string, basePaths: string[]): Promise<string[]> {
  const query = queryPath.replace(/\\/g, "/").toLowerCase().replace(/^\.\//, "");
  if (!query) return [];
  const bare = !query.includes("/");
  const matches: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || matches.length >= MAX_MATCHES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory — skip silently.
    }
    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES) return;
      if (entry.isSymbolicLink()) continue; // Avoid link loops.
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (bare) {
          if (entry.name.toLowerCase() === query) matches.push(full);
        } else {
          const candidate = full.replace(/\\/g, "/").toLowerCase();
          if (candidate.endsWith(query) && (candidate.length === query.length || candidate[candidate.length - query.length - 1] === "/")) {
            matches.push(full);
          }
        }
      }
    }
  };

  for (const base of new Set(basePaths)) {
    await walk(base, 0);
    if (matches.length >= MAX_MATCHES) break;
  }
  return matches;
}
