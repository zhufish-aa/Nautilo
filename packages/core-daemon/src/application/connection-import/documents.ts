import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { configGet } from "../../runtime/config-document.js";
import type { NativeConnectionScan } from "@agenthub/schemas";

// Native files are heterogeneous. Every value crossing IPC is explicitly projected.
export type Doc = Record<string, any>;
export const record = (value: unknown): Doc => value && typeof value === "object" && !Array.isArray(value) ? value as Doc : {};
export const text = (doc: Doc, ...keys: string[]): string | undefined => keys.map(k => doc[k]).find(v => typeof v === "string" && v.trim());
export function cleanKey(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() && !raw.trim().startsWith("sk-ant-oat") && !raw.includes("\n") && raw.length <= 32768 ? raw.trim() : undefined;
}
export class Documents {
  readonly reports: NativeConnectionScan["sources"] = [];
  constructor(readonly env: NodeJS.ProcessEnv) {}
  read(harness: string, path: string): Doc {
    if (!existsSync(path)) return {};
    try {
      if (statSync(path).size > 4 * 1024 * 1024) throw Error();
      const value = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
      const parsed = /\.ya?ml$/i.test(path) ? parseYaml(value, { maxAliasCount: 50 }) : configGet(value, path.endsWith(".toml") ? "toml" : "json", []);
      this.reports.push({ harness, path, status: "read" });
      return parsed ?? {};
    } catch { this.reports.push({ harness, path, status: "error", error: "CONFIG_UNREADABLE" }); return {}; }
  }
  key(raw: unknown, refs: Doc, path: string): string | undefined {
    if (typeof raw !== "string" || !raw.trim() || raw.trim().startsWith("!")) return;
    raw = raw.trim();
    const value = raw as string;
    const env = value.match(/^\{env:(.+)\}$/)?.[1] ?? value.match(/^\$\{(.+)\}$/)?.[1];
    if (env) return cleanKey(refs[env] ?? this.env[env]);
    const file = value.match(/^\{file:(.+)\}$/)?.[1];
    if (file) {
      try { const resolved = file.startsWith("~/") ? join(this.env.HOME ?? this.env.USERPROFILE ?? "", file.slice(2)) : join(dirname(path), file);
        return statSync(resolved).size <= 65536 ? cleanKey(readFileSync(resolved, "utf8")) : undefined;
      } catch { return; }
    }
    if (value.includes("${") || value.startsWith("{")) return;
    if (/^[A-Z0-9_]+$/.test(value) && value.includes("_")) return cleanKey(refs[value] ?? this.env[value]);
    return cleanKey(value);
  }
}
