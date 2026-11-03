import { opendir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const READ_BATCH_SIZE = 16;
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set([
  ".git", ".svn", ".hg", "node_modules", "vendor", "dist", "build", "out", ".next", ".nuxt",
  "coverage", "target", "bin", "obj", ".cache", ".turbo", ".pnpm-store"
]);
const TEXT_EXTENSIONS = new Set([
  "", ".txt", ".md", ".mdx", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm",
  ".css", ".scss", ".sass", ".less", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".vue", ".svelte", ".py", ".go", ".rs", ".java", ".kt", ".kts", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".php", ".rb", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".sql", ".graphql", ".gql",
  ".env", ".ini", ".cfg", ".conf", ".properties", ".gradle", ".swift", ".dart", ".lua", ".r"
]);

export interface WorkspaceSnapshot {
  root: string;
  files: Map<string, string>;
  truncated: boolean;
  traversalComplete: boolean;
  unavailablePaths: Set<string>;
}

/** Captures a bounded text baseline so non-Git workspaces still get diffs. */
export async function captureWorkspaceSnapshot(rootPath: string): Promise<WorkspaceSnapshot> {
  const root = resolve(rootPath);
  const files = new Map<string, string>();
  let totalBytes = 0;
  let truncated = false;
  let traversalComplete = true;
  const unavailablePaths = new Set<string>();
  const unavailable = (path: string, directory = false): void => { unavailablePaths.add(relative(root, path).replaceAll("\\", "/") + (directory ? "/" : "")); };

  const visit = async (directory: string): Promise<void> => {
    if (truncated) return;
    const entries = await opendir(directory).catch(() => undefined);
    if (!entries) { traversalComplete = false; unavailable(directory, true); return; }
    // Read a small batch concurrently, but commit in directory order. Flush
    // before descending so both traversal order and truncation stay unchanged.
    // At most READ_BATCH_SIZE files are in flight (each at most 1 MiB).
    let pending: string[] = [];
    const flush = async (): Promise<void> => {
      const batch = pending;
      pending = [];
      const results = await Promise.all(batch.map(async (path) => {
        const info = await stat(path).catch(() => undefined);
        if (!info || info.size > MAX_FILE_BYTES) { unavailable(path); return undefined; }
        const content = await readFile(path, "utf8").catch(() => undefined);
        return { path, size: info.size, content };
      }));
      for (const result of results) {
        if (!result) continue;
        // Check the original stat size before filtering unreadable/binary
        // content, just as the sequential implementation did.
        if (files.size >= MAX_FILES || totalBytes + result.size > MAX_TOTAL_BYTES) {
          truncated = true;
          break;
        }
        if (result.content === undefined || result.content.includes("\0")) { unavailable(result.path); continue; }
        files.set(relative(root, result.path).replaceAll("\\", "/"), result.content);
        totalBytes += Buffer.byteLength(result.content);
      }
    };
    for await (const entry of entries) {
      if (truncated) break;
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) { unavailable(path); unavailable(path, true); continue; }
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          await flush();
          if (!truncated) await visit(path);
        } else unavailable(path, true);
        continue;
      }
      if (!entry.isFile() || !TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) { unavailable(path); continue; }
      pending.push(path);
      if (pending.length >= READ_BATCH_SIZE) await flush();
    }
    if (!truncated) await flush();
  };

  await visit(root);
  return { root, files, truncated, traversalComplete: traversalComplete && !truncated, unavailablePaths };
}
