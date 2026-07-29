import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderCapability } from "@agenthub/domain";
import type { AdapterMcpServer } from "../adapters/index.js";
import { Database } from "../database/index.js";
import { CoreError } from "../errors.js";

/**
 * Resolves a stored MCP capability into an adapter server spec. Environment
 * references (stdio passthrough, HTTP Bearer token and env-sourced headers)
 * are expanded from the daemon process environment at session start.
 */
export function capabilityToMcpServer(capability: ProviderCapability, environ: NodeJS.ProcessEnv = process.env): AdapterMcpServer | undefined {
  const mcp = capability.mcp;
  if (capability.kind !== "mcp" || !mcp) return undefined;
  const env: Record<string, string> = { ...mcp.env };
  for (const name of mcp.envPassthrough ?? []) {
    const value = environ[name];
    if (value !== undefined && env[name] === undefined) env[name] = value;
  }
  const headers: Record<string, string> = { ...mcp.headers };
  if (mcp.bearerTokenEnvVar) {
    const token = environ[mcp.bearerTokenEnvVar];
    if (token) headers.Authorization = headers.Authorization ?? `Bearer ${token}`;
  }
  const envHeaders: Record<string, string> = mcp.envHeaders ?? {};
  for (const [header, envName] of Object.entries(envHeaders)) {
    const value = environ[envName];
    if (value !== undefined) headers[header] = value;
  }
  return {
    // Provider tool names derive from the server name; keep it CLI-safe.
    name: capability.name.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "mcp",
    transport: mcp.transport,
    command: mcp.command,
    args: mcp.args,
    env: Object.keys(env).length ? env : undefined,
    cwd: mcp.cwd,
    url: mcp.url,
    headers: Object.keys(headers).length ? headers : undefined
  };
}

/** Stamped into every skill file we write so re-imports recognise our own output. */
export const SKILL_FILE_MARKER = "agenthub:capability:";

/** Conventional skill file names; the directory carrying one holds the skill's resources. */
export const SKILL_FILE_NAMES: ReadonlySet<string> = new Set(["skill.md", "skills.md", "skill.markdown", "skills.markdown"]);

interface SkillTarget {
  /** Core Daemon provider id. */
  providerId: string;
  /** Absolute file path the skill body is materialized to. */
  filePath: (slug: string) => string;
  /**
   * Skill directory for directory-based providers; resource files are mirrored
   * here. Undefined for flat formats (e.g. codex prompts), which cannot hold
   * resources.
   */
  skillDir?: (slug: string) => string;
  /** Wraps the skill into the provider's native file format. */
  render: (capability: ProviderCapability, slug: string) => string;
}

/** Directory/file name a skill is materialized under; imports must keep these unique. */
export function slugify(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "skill";
}

function frontmatterSkill(capability: ProviderCapability, slug: string): string {
  const description = capability.description.replace(/\s+/g, " ").trim();
  return [
    "---",
    `name: ${slug}`,
    `description: ${description || slug}`,
    "---",
    "",
    capability.skill?.instructions.trim() ?? "",
    "",
    `<!-- ${SKILL_FILE_MARKER}${capability.id} -->`,
    ""
  ].join("\n");
}

function plainSkill(capability: ProviderCapability): string {
  return [
    capability.skill?.instructions.trim() ?? "",
    "",
    `<!-- ${SKILL_FILE_MARKER}${capability.id} -->`,
    ""
  ].join("\n");
}

/**
 * Providers with a documented user-level skill directory. Skills are written
 * when enabled for the provider and removed again when disabled or deleted.
 */
function skillTargets(): SkillTarget[] {
  const home = homedir();
  const kimiHome = process.env.KIMI_CODE_HOME?.trim() || join(home, ".kimi-code");
  return [
    {
      providerId: "claude-code",
      filePath: (slug) => join(home, ".claude", "skills", slug, "SKILL.md"),
      skillDir: (slug) => join(home, ".claude", "skills", slug),
      render: frontmatterSkill
    },
    {
      providerId: "kimi-code",
      filePath: (slug) => join(kimiHome, "skills", slug, "SKILL.md"),
      skillDir: (slug) => join(kimiHome, "skills", slug),
      render: frontmatterSkill
    },
    {
      providerId: "codex",
      filePath: (slug) => join(home, ".codex", "prompts", `${slug}.md`),
      render: plainSkill
    }
  ];
}

/** Writes/removes provider-native skill files for AgentHub-managed skills. */
export class SkillFileSync {
  /** Reconciles the on-disk state of one capability across all known providers. */
  sync(capability: ProviderCapability): void {
    const slug = slugify(capability.name);
    for (const target of skillTargets()) {
      const shouldInstall = capability.kind === "skill"
        && capability.enabled
        && Boolean(capability.skill?.instructions.trim())
        && capability.providerIds.includes(target.providerId);
      if (shouldInstall) this.install(target, capability, slug);
      else this.remove(target, capability, slug);
    }
  }

  /**
   * Removes every skill file this capability installed. Mirrored resource
   * files are deliberately left behind: they may be the user's originals when
   * the skill was imported from that very directory.
   */
  removeAll(capability: ProviderCapability): void {
    const slug = slugify(capability.name);
    for (const target of skillTargets()) this.remove(target, capability, slug);
  }

  private install(target: SkillTarget, capability: ProviderCapability, slug: string): void {
    try {
      const filePath = target.filePath(slug);
      if (existsSync(filePath)) {
        const existing = readFileSync(filePath, "utf8");
        if (!existing.includes(SKILL_FILE_MARKER)) return; // Never overwrite user-owned skills.
      }
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, target.render(capability, slug), "utf8");
      if (target.skillDir) this.copyResources(capability, target.skillDir(slug));
    } catch (error) {
      console.error(`Failed to sync skill "${capability.name}" for ${target.providerId}`, error);
    }
  }

  /**
   * Mirrors a scanned skill's resource files (references/, scripts/, …) next to
   * the rendered SKILL.md. Everything in the source directory except the skill
   * file itself is copied; the copy is refreshed on every sync. Never deletes
   * and never touches the source directory itself — a self-copy is skipped, so
   * re-importing from a provider's skill folder stays a no-op there.
   */
  private copyResources(capability: ProviderCapability, targetDir: string): void {
    const sourceDir = capability.skill?.resourceDir;
    if (!sourceDir) return;
    if (resolve(sourceDir) === resolve(targetDir)) return;
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) return;
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      // The target renders its own SKILL.md; only the resources come along.
      if (entry.isFile() && SKILL_FILE_NAMES.has(entry.name.toLowerCase())) continue;
      cpSync(join(sourceDir, entry.name), join(targetDir, entry.name), { recursive: true });
    }
  }

  private remove(target: SkillTarget, capability: ProviderCapability, slug: string): void {
    try {
      const filePath = target.filePath(slug);
      if (!existsSync(filePath)) return;
      const existing = readFileSync(filePath, "utf8");
      // Only remove files AgentHub wrote for this exact capability.
      if (!existing.includes(`${SKILL_FILE_MARKER}${capability.id}`)) return;
      rmSync(filePath, { force: true });
    } catch (error) {
      console.error(`Failed to remove skill "${capability.name}" for ${target.providerId}`, error);
    }
  }
}

export class CapabilityService {
  private readonly skillFiles: SkillFileSync;
  constructor(private readonly database: Database, skillFiles?: SkillFileSync) {
    this.skillFiles = skillFiles ?? new SkillFileSync();
  }

  list(): ProviderCapability[] {
    return this.database.capabilities.list();
  }

  upsert(input: ProviderCapability): ProviderCapability {
    validateCapability(input);
    const now = new Date().toISOString();
    const existing = this.database.capabilities.get(input.id);
    const capability: ProviderCapability = {
      ...input,
      name: input.name.trim(),
      description: input.description.trim(),
      tags: input.tags.map((tag) => tag.trim()).filter(Boolean),
      providerIds: [...new Set(input.providerIds)],
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now
    };
    this.database.capabilities.save(capability, capability.updatedAt);
    this.skillFiles.sync(capability);
    return capability;
  }

  remove(capabilityId: string): { removed: true } {
    const existing = this.database.capabilities.get(capabilityId);
    if (existing) this.skillFiles.removeAll(existing);
    this.database.capabilities.remove(capabilityId);
    return { removed: true };
  }
}

function validateCapability(capability: ProviderCapability): void {
  if (!capability.name?.trim()) {
    throw new CoreError("IPC_INVALID_REQUEST", { field: "name", reason: "Capability name cannot be empty." });
  }
  if (capability.kind === "mcp") {
    const mcp = capability.mcp;
    if (!mcp) throw new CoreError("IPC_INVALID_REQUEST", { field: "mcp", reason: "MCP capability requires a server config." });
    if (mcp.transport === "stdio" && !mcp.command?.trim()) {
      throw new CoreError("IPC_INVALID_REQUEST", { field: "mcp.command", reason: "STDIO MCP server requires a launch command." });
    }
    if (mcp.transport === "http" && !mcp.url?.trim()) {
      throw new CoreError("IPC_INVALID_REQUEST", { field: "mcp.url", reason: "HTTP MCP server requires a URL." });
    }
  }
  if (capability.kind === "skill" && !capability.skill?.instructions.trim()) {
    throw new CoreError("IPC_INVALID_REQUEST", { field: "skill.instructions", reason: "Skill instructions cannot be empty." });
  }
}
