import type { DatabaseSync } from "node:sqlite";
type Row = Record<string, unknown>;

export class JsonRepository<T extends { id: string }> {
  constructor(protected readonly db: DatabaseSync, private readonly table: string) {}
  save(value: T, updatedAt: string): void {
    this.db.prepare(`INSERT INTO ${this.table}(id, data, updated_at) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`)
      .run(value.id, JSON.stringify(value), updatedAt);
  }
  get(id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${this.table} WHERE id = ?`).get(id) as Row | undefined;
    return row ? JSON.parse(String(row.data)) as T : undefined;
  }
  list(order = "updated_at DESC"): T[] {
    return (this.db.prepare(`SELECT data FROM ${this.table} ORDER BY ${order}`).all() as Row[])
      .map((row) => JSON.parse(String(row.data)) as T);
  }
  remove(id: string): boolean {
    return Number(this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id).changes) > 0;
  }
}
