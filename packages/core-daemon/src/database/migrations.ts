import type { DatabaseSync } from "node:sqlite";

export function migrateDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_project_runs_project ON project_runs(project_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, member_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_run_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(project_run_id, updated_at);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS runtime_events (event_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, session_id TEXT, project_run_id TEXT, run_id TEXT, data TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_events_session_sequence ON runtime_events(session_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_events_run_sequence ON runtime_events(run_id, sequence);
    CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, project_run_id TEXT, task_id TEXT, session_id TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_project_run ON artifacts(project_run_id, created_at);
    CREATE TABLE IF NOT EXISTS verification_results (id TEXT PRIMARY KEY, project_run_id TEXT NOT NULL, task_id TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_verification_project_run ON verification_results(project_run_id, created_at);
    CREATE TABLE IF NOT EXISTS permission_policies (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, status TEXT NOT NULL, project_run_id TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC);
    CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, action TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, data TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);
    CREATE TABLE IF NOT EXISTS credentials (agent_instance_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO schema_meta(key, value) VALUES('schema', '4') ON CONFLICT(key) DO NOTHING;
  `);
  ensureColumn(db, "artifacts", "project_run_id", "TEXT");
  ensureColumn(db, "artifacts", "task_id", "TEXT");
  ensureColumn(db, "artifacts", "session_id", "TEXT");
  const version = currentSchemaVersion(db);
  if (version < 5) migrateExecutionDefaultsToTeamMembers(db);
  if (version < 5) setSchemaVersion(db, 5);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

interface ExecutionDefaults {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
}

type JsonRecord = Record<string, unknown>;

/**
 * Schema 5 separates a reusable CLI connection from execution policy:
 * AgentInstance owns connectivity, TeamMember owns delegated-run defaults, and
 * Session stores the immutable choices used by a concrete conversation.
 */
function migrateExecutionDefaultsToTeamMembers(db: DatabaseSync): void {
  const agentDefaults = new Map<string, ExecutionDefaults>();
  const memberDefaults = new Map<string, ExecutionDefaults>();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of jsonRows(db, "agents")) {
      const agent = parseRecord(row.data);
      if (!agent) continue;
      const defaults = executionDefaults(agent);
      if (defaults.model || defaults.reasoningEffort || defaults.serviceTier) {
        agentDefaults.set(row.id, defaults);
      }
      const removedModel = deleteOwn(agent, "model");
      const removedReasoning = deleteOwn(agent, "reasoningEffort");
      const removedServiceTier = deleteOwn(agent, "serviceTier");
      const changed = removedModel || removedReasoning || removedServiceTier;
      if (changed) updateJson(db, "agents", row.id, agent);
    }

    for (const row of jsonRows(db, "teams")) {
      const team = parseRecord(row.data);
      if (!team || !Array.isArray(team.members)) continue;
      let changed = false;
      for (const value of team.members) {
        const member = asRecord(value);
        if (!member) continue;
        const inherited = agentDefaults.get(stringValue(member.agentInstanceId) ?? "") ?? {};
        changed = copyMissingDefaults(member, inherited) || changed;
        const memberId = stringValue(member.id);
        if (memberId) memberDefaults.set(`${row.id}:${memberId}`, executionDefaults(member));
      }
      if (changed) updateJson(db, "teams", row.id, team);
    }

    for (const row of jsonRows(db, "sessions")) {
      const session = parseRecord(row.data);
      if (!session) continue;
      const teamId = stringValue(session.teamId);
      const memberId = stringValue(session.memberId);
      const instanceId = stringValue(session.agentInstanceId) ?? memberId;
      const inherited = teamId && memberId
        ? memberDefaults.get(`${teamId}:${memberId}`) ?? agentDefaults.get(instanceId ?? "")
        : agentDefaults.get(instanceId ?? "");
      if (inherited && copyMissingDefaults(session, inherited)) updateJson(db, "sessions", row.id, session);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function currentSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema'").get() as { value?: unknown } | undefined;
  const value = Number.parseInt(String(row?.value ?? "0"), 10);
  return Number.isFinite(value) ? value : 0;
}

function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare("INSERT INTO schema_meta(key, value) VALUES('schema', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(version));
}

function jsonRows(db: DatabaseSync, table: "agents" | "teams" | "sessions"): Array<{ id: string; data: string }> {
  return db.prepare(`SELECT id, data FROM ${table}`).all() as Array<{ id: string; data: string }>;
}

function updateJson(db: DatabaseSync, table: "agents" | "teams" | "sessions", id: string, value: JsonRecord): void {
  db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(JSON.stringify(value), id);
}

function parseRecord(value: string): JsonRecord | undefined {
  try { return asRecord(JSON.parse(value) as unknown); } catch { return undefined; }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function executionDefaults(value: JsonRecord): ExecutionDefaults {
  return {
    model: stringValue(value.model),
    reasoningEffort: stringValue(value.reasoningEffort),
    serviceTier: stringValue(value.serviceTier)
  };
}

function copyMissingDefaults(target: JsonRecord, source: ExecutionDefaults): boolean {
  let changed = false;
  for (const key of ["model", "reasoningEffort", "serviceTier"] as const) {
    if (!Object.prototype.hasOwnProperty.call(target, key) && source[key]) {
      target[key] = source[key];
      changed = true;
    }
  }
  return changed;
}

function deleteOwn(target: JsonRecord, key: keyof ExecutionDefaults): boolean {
  if (!Object.prototype.hasOwnProperty.call(target, key)) return false;
  delete target[key];
  return true;
}
