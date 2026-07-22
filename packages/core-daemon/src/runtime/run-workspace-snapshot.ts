import { opendir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

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
}

/** Captures a bounded text baseline so non-Git workspaces still get diffs. */
export async function captureWorkspaceSnapshot(rootPath: string): Promise<WorkspaceSnapshot> {
  const root = resolve(rootPath);
  const files = new Map<string, string>();
  let totalBytes = 0;
  let truncated = false;

  const visit = async (directory: string): Promise<void> => {
    if (truncated) return;
    const entries = await opendir(directory).catch(() => undefined);
    if (!entries) return;
    for await (const entry of entries) {
      if (truncated) break;
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(path);
        continue;
      }
      if (!entry.isFile() || !TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const info = await stat(path).catch(() => undefined);
      if (!info || info.size > MAX_FILE_BYTES) continue;
      if (files.size >= MAX_FILES || totalBytes + info.size > MAX_TOTAL_BYTES) {
        truncated = true;
        break;
      }
      const content = await readFile(path, "utf8").catch(() => undefined);
      if (content === undefined || content.includes("\0")) continue;
      files.set(relative(root, path).replaceAll("\\", "/"), content);
      totalBytes += Buffer.byteLength(content);
    }
  };

  await visit(root);
  return { root, files, truncated };
}
