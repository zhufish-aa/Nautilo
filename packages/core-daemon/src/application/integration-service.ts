import { randomUUID, createHash } from "node:crypto";
import type {
  ConfigurationPreset,
  ConfigurationPreview,
  IntegrationSettings,
} from "@agenthub/schemas";
import type {
  AgentInstance,
  ProviderCapability,
  RuntimeConnection,
} from "@agenthub/domain";
import { Database } from "../database/index.js";
import { CredentialService } from "../runtime/security/credential-service.js";
import { ConnectionService } from "./connection-service.js";
import { AgentService } from "./agent-service.js";
import { CapabilityService } from "./capability-service.js";

const digest = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(v ?? null))
    .digest("hex");
import { portableConfiguration } from "./portable-configuration.js";
export { portableConfiguration } from "./portable-configuration.js";

export class IntegrationService {
  constructor(
    private readonly db: Database,
    private readonly credentials: CredentialService,
    private readonly connections: ConnectionService,
    private readonly agents: AgentService,
    private readonly capabilities: CapabilityService,
  ) {}
  get(): IntegrationSettings {
    return (
      this.db.integrationSettings.get("integration-settings") ?? {
        id: "integration-settings",
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        toolServices: [],
        gateway: { enabled: false, connectionIds: [] },
      }
    );
  }
  save(input: IntegrationSettings): IntegrationSettings {
    if (
      input.schemaVersion !== 1 ||
      !Array.isArray(input.toolServices) ||
      input.toolServices.length > 3 ||
      !Array.isArray(input.gateway?.connectionIds)
    )
      throw Error("Invalid integration settings");
    const seen = new Set<string>(),
      bindings = input.toolServices.map((b) => {
        if (
          !["image", "vision", "search"].includes(b.purpose) ||
          seen.has(b.purpose)
        )
          throw Error("Invalid or duplicate tool service");
        seen.add(b.purpose);
        if (!b.enabled) return { ...b, enabled: false };
        const head = this.db.runtimeConnections.get(b.connectionId ?? "");
        if (!head?.enabled) throw Error("Select an enabled service connection");
        const revision = b.connectionRevision ?? head.revision,
          version = this.db.runtimeConnections.version(head.id, revision);
        if (!version) throw Error("Pinned service revision was not found");
        if (
          b.model &&
          !(version.models ?? []).some(
            (m) => m.id === b.model && m.enabled !== false,
          )
        )
          throw Error("Select an enabled service model");
        return { ...b, connectionRevision: revision };
      });
    const ids = [...new Set(input.gateway.connectionIds)];
    for (const id of ids) {
      const c = this.db.runtimeConnections.get(id);
      if (
        !c?.enabled ||
        c.kind !== "login" ||
        !["codex", "claude-code"].includes(c.harness ?? "")
      )
        throw Error(
          "Account gateway requires an enabled Codex or Claude Code account",
        );
    }
    const value: IntegrationSettings = {
      id: "integration-settings",
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      toolServices: bindings,
      gateway: { enabled: input.gateway.enabled === true, connectionIds: ids },
    };
    this.db.integrationSettings.save(value, value.updatedAt);
    return value;
  }
  list(): ConfigurationPreset[] {
    return this.db.configurationPresets.list();
  }
  setAccountRoute(connectionId: string, enabled: boolean): void {
    if (typeof enabled !== "boolean") throw Error("Expected a boolean");
    const settings = this.get();
    const ids = settings.gateway.enabled ? settings.gateway.connectionIds.filter(id => id !== connectionId) : [];
    if (enabled) ids.push(connectionId);
    this.save({ ...settings, gateway: { enabled: ids.length > 0, connectionIds: ids } });
  }
  capture(name: string): ConfigurationPreset {
    return this.import({
      id: "",
      name,
      createdAt: "",
      updatedAt: "",
      schemaVersion: 1,
      resources: this.db.capabilities.list(),
      harnesses: this.db.agents.list(),
      connections: this.db.runtimeConnections.list(),
    });
  }
  import(input: ConfigurationPreset): ConfigurationPreset {
    if (
      input.schemaVersion !== 1 ||
      !input.name?.trim() ||
      input.name.length > 120
    )
      throw Error("Invalid configuration format or name");
    const seen = new Set<string>();
    for (const [kind, rows] of [
      ["resource", input.resources],
      ["harness", input.harnesses],
      ["connection", input.connections],
    ] as const) {
      if (!Array.isArray(rows) || rows.length > 200)
        throw Error("Configuration exceeds its resource limit");
      for (const raw of rows) {
        if (!raw || typeof raw !== "object")
          throw Error("Invalid configuration entry");
        const row = raw as Record<string, unknown>;
        if (
          typeof row.id !== "string" ||
          !/^[a-zA-Z0-9_.:-]{1,200}$/.test(row.id) ||
          seen.has(`${kind}:${row.id}`)
        )
          throw Error("Invalid or duplicate entry ID");
        seen.add(`${kind}:${row.id}`);
        if (kind === "resource" && !["skill", "mcp"].includes(String(row.kind)))
          throw Error("Invalid resource kind");
        if (
          kind === "harness" &&
          (typeof row.providerId !== "string" ||
            typeof row.executable !== "string" ||
            !row.executable.trim())
        )
          throw Error("Invalid harness executable");
        if (
          kind === "connection" &&
          !["login", "api"].includes(String(row.kind))
        )
          throw Error("Invalid connection kind");
      }
    }
    const now = new Date().toISOString(),
      clean = portableConfiguration(input) as ConfigurationPreset,
      preset = {
        ...clean,
        id: randomUUID(),
        name: input.name.trim(),
        createdAt: now,
        updatedAt: now,
      };
    if (JSON.stringify(preset).length > 2 * 1024 * 1024)
      throw Error("Configuration exceeds 2 MiB");
    this.db.configurationPresets.save(preset, now);
    return preset;
  }
  export(id: string): ConfigurationPreset {
    const p = this.db.configurationPresets.get(id);
    if (!p) throw Error("Configuration not found");
    return portableConfiguration(p) as ConfigurationPreset;
  }
  remove(id: string): { removed: boolean } {
    return { removed: this.db.configurationPresets.remove(id) };
  }
  preview(id: string, replace = false): ConfigurationPreview {
    const preset = this.export(id),
      entries: ConfigurationPreview["entries"] = [],
      snapshots: Array<{
        kind: string;
        id: string;
        fingerprint: string;
        value: unknown;
      }> = [];
    for (const [kind, rows] of [
      ["resource", preset.resources],
      ["harness", preset.harnesses],
      ["connection", preset.connections],
    ] as const)
      for (const raw of rows) {
        const row = raw as Record<string, unknown>,
          id = String(row.id),
          current = this.read(kind, id);
        let value = { ...row };
        if (kind === "connection" && row.kind === "login") {
          if (!current) {
            entries.push({
              kind,
              id,
              name: String(row.name ?? id),
              operation: "unavailable",
            });
            continue;
          }
          value = {
            ...value,
            loginProfileDirectory: (current as RuntimeConnection)
              .loginProfileDirectory,
          };
        }
        if (kind === "connection" && !current) value.enabled = false;
        entries.push({
          kind,
          id,
          name: String(row.name ?? row.displayName ?? id),
          operation: current ? (replace ? "replace" : "keep") : "create",
          credentialRequired:
            kind === "connection" &&
            row.kind === "api" &&
            !(current as RuntimeConnection)?.hasCredential,
        });
        snapshots.push({ kind, id, fingerprint: digest(current), value });
      }
    const plan: ConfigurationPreview = {
      id: randomUUID(),
      presetId: id,
      state: "preview",
      entries,
    };
    this.credentials.set(`configuration-plan:${plan.id}`, {
      apiKey: randomUUID(),
      plan,
      snapshots,
    } as Parameters<CredentialService["set"]>[1]);
    return plan;
  }
  apply(id: string): ConfigurationPreview {
    const payload = this.credentials.read(
      `configuration-plan:${id}`,
    ) as unknown as
      | {
          plan: ConfigurationPreview;
          snapshots: Array<{
            kind: string;
            id: string;
            fingerprint: string;
            value: unknown;
          }>;
        }
      | undefined;
    if (!payload || payload.plan.state !== "preview")
      throw Error("Configuration preview is no longer applicable");
    for (const s of payload.snapshots)
      if (digest(this.read(s.kind, s.id)) !== s.fingerprint)
        throw Error(
          "Configuration changed after preview; create a new preview",
        );
    for (const e of payload.plan.entries.filter((e) =>
      ["create", "replace"].includes(e.operation),
    )) {
      const row = payload.snapshots.find(
        (s) => s.kind === e.kind && s.id === e.id,
      )!.value;
      if (e.kind === "connection") {
        const c = this.db.runtimeConnections.get(e.id);
        this.connections.upsert({
          connection: row as RuntimeConnection,
          expectedRevision: c?.revision,
        });
      } else if (e.kind === "harness") this.agents.upsert(row as AgentInstance);
      else this.capabilities.upsert(row as ProviderCapability);
    }
    payload.plan.state = "applied";
    this.credentials.set(`configuration-plan:${id}`, {
      apiKey: randomUUID(),
      ...payload,
    } as Parameters<CredentialService["set"]>[1]);
    return payload.plan;
  }
  private read(kind: string, id: string): unknown {
    return kind === "resource"
      ? this.db.capabilities.get(id)
      : kind === "harness"
        ? this.db.agents.get(id)
        : this.db.runtimeConnections.get(id);
  }
}
