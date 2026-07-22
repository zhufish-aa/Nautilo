import type { Task } from "@agenthub/domain";
import type { DatabaseSync } from "node:sqlite";
type Row = Record<string, unknown>;
export class TaskRepository {
  constructor(private readonly db: DatabaseSync) {}
  save(task: Task): void { this.db.prepare("INSERT INTO tasks(id, project_run_id, data, updated_at) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_run_id=excluded.project_run_id, data=excluded.data, updated_at=excluded.updated_at").run(task.id, task.projectRunId, JSON.stringify(task), task.updatedAt); }
  get(id: string): Task | undefined { const row = this.db.prepare("SELECT data FROM tasks WHERE id = ?").get(id) as Row | undefined; return row ? JSON.parse(String(row.data)) as Task : undefined; }
  list(projectRunId: string): Task[] { return (this.db.prepare("SELECT data FROM tasks WHERE project_run_id = ? ORDER BY updated_at").all(projectRunId) as Row[]).map((row) => JSON.parse(String(row.data)) as Task); }
  listAll(): Task[] { return (this.db.prepare("SELECT data FROM tasks ORDER BY updated_at").all() as Row[]).map((row) => JSON.parse(String(row.data)) as Task); }
}
