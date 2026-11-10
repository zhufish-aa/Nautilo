import type { ChangedFile } from "./types";

/** Git quotes paths using C escapes, including octal UTF-8 bytes. */
function decodePath(value: string): string {
  if (!value.startsWith('"')) return value;
  const bytes: number[] = [];
  const body = value.slice(1, value.lastIndexOf('"'));
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", '\\': '\\', '"': '"' };
  for (let i = 0; i < body.length;) {
    if (body[i] === "\\") {
      const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1));
      if (octal) { bytes.push(parseInt(octal[0], 8)); i += octal[0].length + 1; continue; }
      bytes.push(...new TextEncoder().encode(escapes[body[i + 1]] ?? body[i + 1] ?? "")); i += 2;
    } else {
      const char = String.fromCodePoint(body.codePointAt(i)!);
      bytes.push(...new TextEncoder().encode(char)); i += char.length;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Parses a cumulative provider patch, preserving each file's raw patch.
 * Empty snapshots deliberately return no files. Unknown formats remain
 * available verbatim in the provider artifact instead of inventing paths. */
export function parseProviderDiff(diff: string): ChangedFile[] {
  if (!diff.trim()) return [];
  const sections = diff.split(/(?=^diff --git )/m).filter((section) => section.trim());
  const files: ChangedFile[] = [];
  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    let oldPath: string | undefined, newPath: string | undefined;
    let additions = 0, deletions = 0, inHunk = false;
    let changeType: ChangedFile["changeType"] = "modified";
    for (const line of lines) {
      if (line.startsWith("@@")) { inHunk = true; continue; }
      if (inHunk) {
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
        continue;
      }
      if (line.startsWith("new file mode ")) changeType = "added";
      if (line.startsWith("deleted file mode ")) changeType = "deleted";
      if (line.startsWith("--- ")) oldPath = decodePath(line.slice(4).split("\t")[0]);
      if (line.startsWith("+++ ")) newPath = decodePath(line.slice(4).split("\t")[0]);
      if (line.startsWith("rename to ")) newPath = decodePath(line.slice(10));
    }
    if (oldPath === "/dev/null") changeType = "added";
    if (newPath === "/dev/null") changeType = "deleted";
    let path = newPath && newPath !== "/dev/null" ? newPath : oldPath;
    if (!path || path === "/dev/null") {
      // Binary and mode-only patches have no +++/--- headers. Prefer the
      // quoted form, then Git's b/ separator (which permits spaces in paths).
      const header = lines[0]?.slice("diff --git ".length);
      if (lines[0]?.startsWith("diff --git ")) {
        const quoted = /^(?:"(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(header);
        path = quoted ? decodePath(quoted[1]) : undefined;
      }
    }
    if (!path || path === "/dev/null") continue;
    // rename to paths already have no a/b prefix.
    const renamed = lines.some((line) => line.startsWith("rename to ")) && !lines.some((line) => line.startsWith("+++ "));
    if (!renamed) path = path.replace(/^[ab]\//, "");
    files.push({ path, changeType, additions, deletions, diff: section });
  }
  return files;
}
