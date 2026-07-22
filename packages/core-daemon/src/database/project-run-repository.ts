import type { ProjectRun } from "@agenthub/domain";
import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

export class ProjectRunRepository {
  constructor(private readonly db: DatabaseSync) {}

  save(projectRun: ProjectRun): void {
    this.db.prepare(`
      INSERT INTO project_runs(id, project_id, data, updated_at)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id=excluded.project_id,
        data=excluded.data,
        updated_at=excluded.updated_at
    `).run(projectRun.id, projectRun.projectId, JSON.stringify(projectRun), projectRun.updatedAt);
  }

  get(id: string): ProjectRun | undefined {
    const row = this.db.prepare("SELECT data FROM project_runs WHERE id = ?").get(id) as Row | undefined;
    return row ? JSON.parse(String(row.data)) as ProjectRun : undefined;
  }

  list(projectId: string): ProjectRun[] {
    return (this.db.prepare("SELECT data FROM project_runs WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Row[])
      .map((row) => JSON.parse(String(row.data)) as ProjectRun);
  }
  listAll(): ProjectRun[] {
    return (this.db.prepare("SELECT data FROM project_runs ORDER BY updated_at DESC").all() as Row[])
      .map((row) => JSON.parse(String(row.data)) as ProjectRun);
  }
}
