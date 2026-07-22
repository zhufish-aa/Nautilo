import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export class PathPolicy {
  validate(workspacePath: string, changedPaths: string[], allowedPatterns: string[]): string[] {
    const root = realpathSync(workspacePath);
    return changedPaths.filter((relativePath) => {
      const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
      if (!normalized || normalized === ".git" || normalized.startsWith(".git/") || normalized.split("/").includes("..")) return true;
      const absolute = resolve(root, normalized);
      if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return true;
      const existing = nearestExistingPath(absolute, root);
      const actual = realpathSync(existing);
      if (actual !== root && !actual.startsWith(`${root}${sep}`)) return true;
      return allowedPatterns.length > 0 && !allowedPatterns.some((pattern) => glob(pattern, normalized));
    });
  }
}

function nearestExistingPath(path: string, root: string): string {
  let current = path;
  while (!existsSync(current) && current !== root) current = dirname(current);
  return current;
}

function glob(pattern: string, value: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const source = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${source}$`).test(value);
}
