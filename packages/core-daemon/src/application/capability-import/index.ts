import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { ProviderCapability } from "@agenthub/domain";
import type {
  CapabilityImportConflictPolicy,
  CapabilityImportOutcome,
  CapabilityImportPreview,
  CapabilityImportSource,
  CapabilityScanResult,
  DiscoveredMcpSource
} from "@agenthub/schemas";
import { CoreError } from "../../errors.js";
import { CapabilityService, SKILL_FILE_NAMES, slugify } from "../capability-service.js";
import { discoverMcpSources } from "./discovery.js";
import { parseMcpCommandLine } from "./mcp-command.js";
import { parseMcpConfigJson } from "./mcp-json.js";
import { parseMcpConfigToml } from "./mcp-toml.js";
import { parseSkillMarkdown } from "./skill-markdown.js";

export * from "./discovery.js";
export * from "./mcp-command.js";
export * from "./mcp-json.js";
export * from "./mcp-toml.js";
export * from "./skill-markdown.js";

/** Guard rails so pointing the scanner at a huge tree cannot hang the daemon. */
const MAX_SCAN_DEPTH = 4;
const MAX_SCAN_FILES = 300;
const MAX_SKILL_BYTES = 512 * 1024;
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", "target", ".next", "coverage"]);
/** Hidden directories worth descending into anyway — this is where skills live. */
const ALLOWED_HIDDEN_DIRS = new Set([".claude", ".codex", ".agents", ".kimi-code", ".cursor"]);

function emptyPreview(): CapabilityImportPreview {
  return { mcpServers: [], skills: [], errors: [] };
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Appends ` (2)`, ` (3)`, … until `taken` stops rejecting the name. */
function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${name} (${suffix})`;
    if (!taken(candidate)) return candidate;
  }
  return `${name} ${Date.now()}`;
}

interface ScanEntry {
  path: string;
  name: string;
}

/** An unreadable directory (permissions) must not abort the whole scan. */
function readEntries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Bounded probe for directories the depth limit refuses to descend into: does
 * this subtree still hold a conventional skill file? References/templates
 * READMEs are skill resources the SKILL.md preference discards anyway, so only
 * the conventional names count as a loss.
 */
function subtreeHasSkillFile(dir: string, depthLeft: number): boolean {
  for (const entry of readEntries(dir)) {
    if (entry.isFile() && SKILL_FILE_NAMES.has(entry.name.toLowerCase())) return true;
    if (depthLeft > 0 && entry.isDirectory() && !SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
      if (subtreeHasSkillFile(join(dir, entry.name), depthLeft - 1)) return true;
    }
  }
  return false;
}

/** The renderer has no home path, so it sends presets like `~/.claude/skills`. */
function expandHome(dir: string): string {
  if (dir === "~") return homedir();
  if (dir.startsWith("~/") || dir.startsWith("~\\")) return join(homedir(), dir.slice(2));
  return dir;
}

export class CapabilityImportService {
  constructor(private readonly capabilities: CapabilityService) {}

  /** Parses pasted text into preview candidates; never persists anything. */
  parse(input: { source: CapabilityImportSource; text: string; fileName?: string }): CapabilityImportPreview {
    const text = input.text ?? "";
    const origin = input.fileName?.trim() || undefined;
    switch (input.source) {
      case "mcpJson": {
        const { servers, errors } = parseMcpConfigJson(text, origin);
        return { mcpServers: servers, skills: [], errors };
      }
      case "mcpToml": {
        const { servers, errors } = parseMcpConfigToml(text, origin);
        return { mcpServers: servers, skills: [], errors };
      }
      case "mcpCommand": {
        const { servers, errors } = parseMcpCommandLine(text);
        return { mcpServers: servers, skills: [], errors };
      }
      case "skillMarkdown": {
        const fallback = origin ? basename(origin, extname(origin)) : "skill";
        const { skills, errors } = parseSkillMarkdown(text, fallback, origin);
        return { mcpServers: [], skills, errors };
      }
      default:
        throw new CoreError("IPC_INVALID_REQUEST", { field: "source", reason: `Unknown import source: ${String(input.source)}` });
    }
  }

  /** Lists MCP servers already configured in other tools on this machine. */
  discoverMcp(input: { projectRoot?: string } = {}): { sources: DiscoveredMcpSource[] } {
    return { sources: discoverMcpSources(input.projectRoot) };
  }

  /** Walks a directory for skill Markdown files and parses everything it finds. */
  scanSkills(input: { dir: string }): CapabilityScanResult {
    const requested = input.dir?.trim();
    if (!requested) throw new CoreError("IPC_INVALID_REQUEST", { field: "dir", reason: "Scan directory is required." });
    const dir = expandHome(requested);

    const result: CapabilityScanResult = { ...emptyPreview(), scannedFiles: 0, truncated: false };
    let root: ReturnType<typeof statSync>;
    try {
      root = statSync(dir);
    } catch {
      result.errors.push(`目录不存在：${dir}`);
      return result;
    }
    if (!root.isDirectory()) {
      result.errors.push(`不是目录：${dir}`);
      return result;
    }

    const markdown: ScanEntry[] = [];
    const walk = (current: string, depth: number): void => {
      if (markdown.length >= MAX_SCAN_FILES) {
        result.truncated = true;
        return;
      }
      for (const entry of readEntries(current)) {
        if (markdown.length >= MAX_SCAN_FILES) {
          result.truncated = true;
          return;
        }
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          if (SKIPPED_DIRS.has(entry.name)) continue;
          if (entry.name.startsWith(".") && !ALLOWED_HIDDEN_DIRS.has(entry.name)) continue;
          if (depth + 1 > MAX_SCAN_DEPTH) {
            // Too deep to descend — flag it only when a skill file is actually
            // left behind (bounded probe), so routine deep folders stay silent.
            if (subtreeHasSkillFile(full, 2)) {
              result.truncated = true;
            }
            continue;
          }
          walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!/\.(md|markdown)$/i.test(entry.name)) continue;
        markdown.push({ path: full, name: entry.name });
      }
    };
    walk(dir, 0);

    // Prefer the conventional file names; only sweep every .md when there are none,
    // so pointing at a docs folder does not flood the preview.
    const conventional = markdown.filter((entry) => SKILL_FILE_NAMES.has(entry.name.toLowerCase()));
    const selected = conventional.length > 0 ? conventional : markdown;

    for (const entry of selected) {
      try {
        if (statSync(entry.path).size > MAX_SKILL_BYTES) {
          result.truncated = true;
          continue;
        }
        const text = readFileSync(entry.path, "utf8");
        const isConventional = SKILL_FILE_NAMES.has(entry.name.toLowerCase());
        const fallback = isConventional
          // `<skill-name>/SKILL.md` — the directory carries the name.
          ? basename(join(entry.path, "..")) || basename(entry.name, extname(entry.name))
          : basename(entry.name, extname(entry.name));
        const parsed = parseSkillMarkdown(text, fallback, entry.path);
        if (isConventional) {
          // A conventional skill file owns its directory; the sibling files
          // (references/, scripts/, …) are resources the sync mirrors along.
          const resourceDir = join(entry.path, "..");
          for (const skill of parsed.skills) skill.resourceDir = resourceDir;
        }
        result.skills.push(...parsed.skills);
        result.errors.push(...parsed.errors.map((error) => `${entry.name}: ${error}`));
        result.scannedFiles += 1;
      } catch (error) {
        result.errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  /**
   * Bulk-saves candidates, resolving name clashes against existing capabilities
   * and within the batch itself. Skill slugs are kept unique too: `SkillFileSync`
   * writes by slug, so two names that slugify alike would clobber each other on disk.
   */
  importMany(input: { items: ProviderCapability[]; onConflict?: CapabilityImportConflictPolicy }): {
    results: CapabilityImportOutcome[];
  } {
    const policy = input.onConflict ?? "skip";
    const existing = this.capabilities.list();
    const byName = new Map(existing.map((item) => [`${item.kind}:${normalizeName(item.name)}`, item]));
    const takenNames = new Set(existing.map((item) => normalizeName(item.name)));
    const slugOwner = new Map(
      existing.filter((item) => item.kind === "skill").map((item) => [slugify(item.name), item.id])
    );

    const nameTaken = (value: string): boolean => takenNames.has(normalizeName(value));

    const results: CapabilityImportOutcome[] = [];
    for (const item of input.items ?? []) {
      let candidate = item;
      const match = byName.get(`${item.kind}:${normalizeName(item.name)}`);

      if (match) {
        if (policy === "skip") {
          results.push({ name: item.name, status: "skipped", capabilityId: match.id });
          continue;
        }
        if (policy === "overwrite") {
          candidate = {
            ...item,
            id: match.id,
            createdAt: match.createdAt,
            // Keep the provider selection the user already made when the import
            // does not carry one of its own.
            providerIds: item.providerIds.length > 0 ? item.providerIds : match.providerIds
          };
        } else {
          candidate = { ...item, name: uniqueName(item.name, nameTaken) };
        }
      } else if (nameTaken(item.name)) {
        // Same name already consumed earlier in this batch.
        candidate = { ...item, name: uniqueName(item.name, nameTaken) };
      }

      if (candidate.kind === "skill") {
        // Two distinct names can share a slug ("Code Review" / "code-review"),
        // and `SkillFileSync` writes by slug — so the rename has to clear the
        // slug as well, not just the name.
        const slugTaken = (value: string): boolean => {
          const owner = slugOwner.get(slugify(value));
          return owner !== undefined && owner !== candidate.id;
        };
        if (slugTaken(candidate.name)) {
          candidate = { ...candidate, name: uniqueName(candidate.name, (value) => nameTaken(value) || slugTaken(value)) };
        }
        slugOwner.set(slugify(candidate.name), candidate.id);
      }

      try {
        const saved = this.capabilities.upsert(candidate);
        takenNames.add(normalizeName(saved.name));
        byName.set(`${saved.kind}:${normalizeName(saved.name)}`, saved);
        results.push({
          name: saved.name,
          status: match && policy === "overwrite" ? "updated" : "created",
          capabilityId: saved.id
        });
      } catch (error) {
        results.push({ name: item.name, status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { results };
  }
}
