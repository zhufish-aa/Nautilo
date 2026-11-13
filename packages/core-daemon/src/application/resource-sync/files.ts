import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// Bounded filesystem IO only. Conflict resolution belongs to the plan builder.
export type FileChange = {
  path: string;
  before: string | null;
  after: string;
  encoding?: "base64";
};
export const read = (path: string, encoding?: "base64"): string | null => {
  if (!existsSync(path)) return null;
  if (statSync(path).size > 4 * 1024 * 1024)
    throw Error("Native resource exceeds 4 MiB");
  return readFileSync(path).toString(encoding ?? "utf8");
};
export const write = (
  path: string,
  text: string | null,
  encoding?: "base64",
): void => {
  if (text === null) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.nautilo-sync-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, encoding ? Buffer.from(text, encoding) : text, {
      mode: 0o600,
    });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
};
export function bundle(
  root: string,
): Array<{ relative: string; content: string }> {
  const files: Array<{ relative: string; content: string }> = [];
  let bytes = 0;
  const visit = (dir: string, prefix: string, depth: number): void => {
    if (depth > 12) throw Error("Skill resource nesting limit exceeded");
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (
        [".git", "node_modules", ".DS_Store"].includes(e.name) ||
        e.name.startsWith(".nautilo-")
      )
        continue;
      if (e.isSymbolicLink())
        throw Error(
          "Skill resources contain a symbolic link; choose an explicit local copy",
        );
      const relative = join(prefix, e.name),
        path = join(dir, e.name);
      if (e.isDirectory()) visit(path, relative, depth + 1);
      else if (e.isFile() && relative.toLowerCase() !== "skill.md") {
        const size = statSync(path).size;
        if (
          size > 4 * 1024 * 1024 ||
          bytes + size > 8 * 1024 * 1024 ||
          files.length >= 200
        )
          throw Error("Skill resource bundle exceeds its file or size limit");
        bytes += size;
        files.push({
          relative,
          content: readFileSync(path).toString("base64"),
        });
      }
    }
  };
  visit(root, "", 0);
  return files;
}
