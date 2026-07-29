import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentRun, Session } from "@agenthub/domain";
import { Database } from "../database/index.js";
import type { CheckpointRow } from "../database/checkpoint-repository.js";
import { CoreError } from "../errors.js";
import { EventService } from "./event-service.js";
import type { WorkspaceSnapshot } from "./run-workspace-snapshot.js";

const KEEP_PER_SESSION = 20;

export interface CheckpointRevertSummary {
  checkpointId: string;
  restored: string[];
  removed: string[];
  skipped: string[];
  warning?: string;
}

/**
 * Per-turn workspace checkpoints ("回滚到此轮之前"). A bounded text snapshot is
 * captured before each chat run starts; reverting restores exactly the files
 * later runs touched, so files the user created themselves survive.
 */
export class CheckpointService {
  private readonly snapshotDir: string;

  constructor(
    private readonly database: Database,
    dataDir: string,
    private readonly events: EventService
  ) {
    this.snapshotDir = join(dataDir, "checkpoints");
  }

  list(sessionId: string): CheckpointRow[] {
    return this.database.checkpoints.list(sessionId);
  }

  /** Persists a pre-run snapshot; call before the provider turn starts editing. */
  async save(session: Session, run: AgentRun, snapshot: WorkspaceSnapshot): Promise<CheckpointRow> {
    const row: CheckpointRow = {
      id: randomUUID(),
      sessionId: session.id,
      runId: run.id,
      createdAt: new Date().toISOString(),
      truncated: snapshot.truncated
    };
    await mkdir(this.snapshotDir, { recursive: true });
    await writeFile(this.snapshotPath(row.id), JSON.stringify({ root: snapshot.root, files: [...snapshot.files.entries()] }), "utf8");
    this.database.checkpoints.save(row);
    await this.prune(session.id);
    return row;
  }

  /** Records the workspace-relative paths one run touched (drives revert scope). */
  recordTouched(runId: string, cwd: string, paths: string[]): void {
    const root = resolve(cwd);
    const normalized = paths.flatMap((path) => {
      const absolute = resolve(isAbsolute(path) ? path : resolve(root, path));
      const rel = relative(root, absolute).replaceAll("\\", "/");
      return rel && !rel.startsWith("..") && !isAbsolute(rel) ? [rel] : [];
    });
    this.database.checkpoints.addTouched(runId, [...new Set(normalized)]);
  }

  /** Dry-run of revert: which files would be restored / deleted. */
  async preview(checkpointId: string): Promise<Omit<CheckpointRevertSummary, "checkpointId">> {
    const { row, snapshot, touched } = await this.load(checkpointId);
    const restored: string[] = [];
    const removed: string[] = [];
    const skipped: string[] = [];
    for (const path of touched) {
      if (snapshot.files.has(path)) restored.push(path);
      else if (await exists(join(snapshot.root, path))) removed.push(path);
      else skipped.push(path);
    }
    return { restored, removed, skipped, warning: this.warning(row) };
  }

  async revert(checkpointId: string): Promise<CheckpointRevertSummary> {
    const { row, snapshot, touched } = await this.load(checkpointId);
    const restored: string[] = [];
    const removed: string[] = [];
    const skipped: string[] = [];
    for (const path of touched) {
      const absolute = join(snapshot.root, path);
      const before = snapshot.files.get(path);
      if (before !== undefined) {
        await mkdir(resolve(absolute, ".."), { recursive: true });
        await writeFile(absolute, before, "utf8");
        restored.push(path);
      } else if (await exists(absolute)) {
        await rm(absolute, { force: true });
        removed.push(path);
      } else {
        skipped.push(path);
      }
    }
    const summary: CheckpointRevertSummary = {
      checkpointId: row.id,
      restored,
      removed,
      skipped,
      warning: this.warning(row)
    };
    const session = this.database.sessions.get(row.sessionId);
    if (session) {
      this.events.appendForSession(session, {}, "session.checkpoint_reverted", {
        checkpointId: row.id,
        restored,
        removed,
        skipped,
        ...(summary.warning ? { warning: summary.warning } : {})
      });
    }
    return summary;
  }

  private async load(checkpointId: string): Promise<{ row: CheckpointRow; snapshot: { root: string; files: Map<string, string> }; touched: string[] }> {
    const row = this.database.checkpoints.get(checkpointId);
    if (!row) throw new CoreError("IPC_NOT_FOUND", { resource: "checkpoint", id: checkpointId });
    const raw = await readFile(this.snapshotPath(row.id), "utf8").catch(() => undefined);
    if (!raw) throw new CoreError("IPC_NOT_FOUND", { resource: "checkpoint snapshot", id: checkpointId });
    const parsed = JSON.parse(raw) as { root: string; files: Array<[string, string]> };
    const snapshot = { root: parsed.root, files: new Map(parsed.files) };
    // Scope = the checkpoint's own run plus every later run of the session.
    // (The run row predates the checkpoint by a few ms, so comparing against
    // checkpoint.createdAt would exclude the very run it belongs to.)
    const anchor = row.runId ? this.database.runs.get(row.runId) : undefined;
    const since = anchor?.startedAt ?? row.createdAt;
    const runIds = this.database.runs.list()
      .filter((run) => run.sessionId === row.sessionId && (run.id === row.runId || (run.startedAt ?? "") >= since))
      .map((run) => run.id);
    const touched = this.database.checkpoints.touchedForRuns(runIds).filter((path) => this.insideRoot(snapshot.root, path));
    return { row, snapshot, touched };
  }

  private insideRoot(root: string, path: string): boolean {
    const rel = relative(resolve(root), resolve(root, path)).replaceAll("\\", "/");
    return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
  }

  private warning(row: CheckpointRow): string | undefined {
    return row.truncated ? "checkpoint_snapshot_truncated" : undefined;
  }

  private snapshotPath(id: string): string {
    return join(this.snapshotDir, `${id}.json`);
  }

  private async prune(sessionId: string): Promise<void> {
    const rows = this.database.checkpoints.list(sessionId);
    const excess = rows.slice(KEEP_PER_SESSION);
    if (!excess.length) return;
    this.database.checkpoints.delete(excess.map((row) => row.id));
    await Promise.all(excess.map((row) => rm(this.snapshotPath(row.id), { force: true }).catch(() => undefined)));
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}
