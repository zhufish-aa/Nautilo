import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ResourceInventory,
  ResourcePlanInput,
  ResourceSyncPlan,
} from "@agenthub/schemas";
import { Database } from "../database/index.js";
import { CredentialService } from "../runtime/security/credential-service.js";
import { RedactionService } from "../runtime/security/redaction-service.js";
import { capabilityToMcpServer } from "./capability-service.js";
import { configGet, configSet } from "../runtime/config-document.js";
import { read, write, bundle, type FileChange } from "./resource-sync/files.js";
import { nativeTargets } from "./resource-sync/native-targets.js";
import { nativeMcp, safe } from "./resource-sync/mcp-entry.js";

export { nativeTargets } from "./resource-sync/native-targets.js";

const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    );
  const x = Object.keys(a),
    y = Object.keys(b);
  return (
    x.length === y.length &&
    x.every(
      (k) =>
        Object.hasOwn(b, k) &&
        equal(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
    )
  );
};
const slug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "skill";
export class ResourceService {
  constructor(
    private readonly db: Database,
    private readonly credentials: CredentialService,
    private readonly redaction = new RedactionService(),
  ) {}
  inventory(): ResourceInventory {
    return {
      resources: this.db.capabilities.list().map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        enabled: c.enabled,
        providerIds: c.providerIds,
        source:
          c.origin?.label ??
          c.origin?.kind ??
          (c.tags.includes("builtin")
            ? "builtin"
            : (c.skill?.source ?? "unknown")),
        sourcePath: c.origin?.path ?? c.skill?.resourceDir,
        owner: "nautilo",
        updatedAt: c.updatedAt,
      })),
      targets: nativeTargets(this.db.runtimeConnections.list()),
    };
  }
  history(): ResourceSyncPlan[] {
    return this.db.resourceTransactions.list().slice(0, 50);
  }
  preview(input: ResourcePlanInput): ResourceSyncPlan {
    const target = this.inventory().targets.find(
      (t) => t.id === input.targetId,
    );
    if (!target) throw Error("Native target not found");
    if (input.capabilityIds.length > 200) throw Error("Too many resources");
    const resolution = input.resolution ?? "keep";
    if (!["keep", "replace", "rename"].includes(resolution))
      throw Error("Unknown conflict resolution");
    const changes: ResourceSyncPlan["changes"] = [],
      files = new Map<string, FileChange>();
    for (const id of input.capabilityIds) {
      const cap = this.db.capabilities.get(id);
      if (!cap) throw Error("Capability not found");
      if (cap.kind === "mcp") {
        if (!target.mcpPath)
          throw Error(
            "This harness merges MCP through invocation configuration; no verified global MCP file is available",
          );
        const path = target.mcpPath,
          format = target.providerId === "codex" ? "toml" : "json",
          before = read(path),
          previous =
            files.get(path)?.after ??
            before ??
            (format === "toml" ? "" : "{}\n"),
          server = capabilityToMcpServer(cap);
        if (!server) throw Error("Invalid MCP configuration");
        const section =
          target.providerId === "codex"
            ? "mcp_servers"
            : target.providerId === "opencode"
              ? "mcp"
              : "mcpServers";
        let key = server.name;
        const desired = nativeMcp(server, target.providerId),
          existing = configGet(previous, format, [section, key]),
          same = equal(existing, desired),
          conflict = existing !== undefined && !same;
        if (conflict && resolution === "rename") {
          key = `${server.name}-nautilo`;
          let count = 2;
          while (
            configGet(previous, format, [section, key]) !== undefined &&
            !equal(configGet(previous, format, [section, key]), desired)
          ) {
            key = `${server.name}-nautilo-${count++}`;
          }
        }
        const operation = same
          ? "unchanged"
          : conflict && resolution === "keep"
            ? "keep"
            : conflict && resolution === "rename"
              ? "rename"
              : existing === undefined
                ? "create"
                : "update";
        const after = ["keep", "unchanged"].includes(operation)
          ? previous
          : configSet(previous, format, [section, key], desired);
        files.set(path, {
          path,
          before: files.get(path)?.before ?? before,
          after,
        });
        changes.push({
          resourceId: id,
          name: cap.name,
          path,
          operation,
          conflict,
          before:
            existing === undefined ? undefined : JSON.stringify(safe(existing)),
          after: JSON.stringify(safe(desired)),
        });
      } else {
        if (!target.skillDirectory)
          throw Error("This harness has no verified native skill directory");
        if (!cap.skill?.instructions?.trim())
          throw Error("Skill instructions are missing");
        let path = join(target.skillDirectory, slug(cap.name), "SKILL.md");
        const marker = `<!-- agenthub:capability:${id} -->`,
          desired = `---\nname: ${slug(cap.name)}\ndescription: ${JSON.stringify(cap.description || cap.name)}\n---\n\n${cap.skill.instructions}\n\n${marker}\n`;
        const original = read(path),
          conflict = original !== null && original !== desired;
        if (conflict && resolution === "rename") {
          const base = join(
            target.skillDirectory,
            `${slug(cap.name)}-nautilo-${id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`,
          );
          path = join(base, "SKILL.md");
          let n = 2;
          while (read(path) !== null && read(path) !== desired)
            path = join(`${base}-${n++}`, "SKILL.md");
        }
        const before = read(path),
          operation =
            before === desired
              ? "unchanged"
              : conflict && resolution === "keep"
                ? "keep"
                : conflict && resolution === "rename"
                  ? "rename"
                  : before === null
                    ? "create"
                    : "update";
        files.set(path, {
          path,
          before,
          after: ["keep", "unchanged"].includes(operation)
            ? (before ?? "")
            : desired,
        });
        changes.push({
          resourceId: id,
          name: cap.name,
          path,
          operation,
          conflict,
        });
        if (operation !== "keep" && cap.skill.resourceDir)
          for (const entry of bundle(cap.skill.resourceDir)) {
            const destination = join(dirname(path), entry.relative),
              before = read(destination, "base64"),
              conflict = before !== null && before !== entry.content;
            const operation =
              before === entry.content
                ? "unchanged"
                : conflict && resolution !== "replace"
                  ? "keep"
                  : before === null
                    ? "create"
                    : "update";
            files.set(destination, {
              path: destination,
              before,
              after: operation === "keep" ? before! : entry.content,
              encoding: "base64",
            });
            changes.push({
              resourceId: id,
              name: entry.relative,
              path: destination,
              operation,
              conflict,
              resourceFile: true,
            });
          }
      }
    }
    const now = new Date().toISOString(),
      plan: ResourceSyncPlan = {
        id: randomUUID(),
        targetId: target.id,
        state: "preview",
        createdAt: now,
        changes,
      };
    if (
      files.size > 256 ||
      [...files.values()].reduce(
        (n, f) => n + f.after.length + (f.before?.length ?? 0),
        0,
      ) >
        16 * 1024 * 1024
    )
      throw Error(
        "Sync plan exceeds 256 files or 16 MiB; select fewer resources",
      );
    this.credentials.set(`resource-plan:${plan.id}`, {
      apiKey: randomUUID(),
      files: [...files.values()].filter((f) => f.before !== f.after),
    } as Parameters<CredentialService["set"]>[1]);
    const publicPlan = this.redaction.value(plan);
    this.db.resourceTransactions.save(publicPlan, now);
    return publicPlan;
  }
  apply(id: string, undo = false): ResourceSyncPlan {
    const plan = this.db.resourceTransactions.get(id);
    if (!plan || plan.state !== (undo ? "applied" : "preview"))
      throw Error("This sync plan is no longer applicable");
    const payload = this.credentials.read(`resource-plan:${id}`) as unknown as
      | { files: FileChange[] }
      | undefined;
    if (!payload) throw Error("Resource backup not found");
    for (const file of payload.files)
      if (read(file.path, file.encoding) !== (undo ? file.after : file.before))
        throw Error(
          "Native files changed after preview; refresh the preview before applying or undoing",
        );
    const written: FileChange[] = [];
    try {
      for (const file of payload.files) {
        write(file.path, undo ? file.before : file.after, file.encoding);
        written.push(file);
      }
    } catch (error) {
      for (const file of written.reverse())
        if (
          read(file.path, file.encoding) === (undo ? file.before : file.after)
        )
          write(file.path, undo ? file.after : file.before, file.encoding);
      throw error;
    }
    plan.state = undo ? "undone" : "applied";
    this.db.resourceTransactions.save(plan, new Date().toISOString());
    return plan;
  }
}
