import type { RuntimeConnection } from "@agenthub/domain";
import type { DatabaseSync } from "node:sqlite";
import { JsonRepository } from "./json-repository.js";

export class RuntimeConnectionRepository extends JsonRepository<RuntimeConnection> {
  constructor(db: DatabaseSync) { super(db, "runtime_connections"); }
  version(id: string, revision: number): RuntimeConnection | undefined {
    const row = this.db.prepare("SELECT data FROM runtime_connection_versions WHERE id = ?").get(`${id}:${revision}`);
    return row ? JSON.parse(String(row.data)) as RuntimeConnection : undefined;
  }
  appendVersion(connection: RuntimeConnection): void {
    this.db.prepare("INSERT INTO runtime_connection_versions(id,data,updated_at) VALUES(?,?,?)")
      .run(`${connection.id}:${connection.revision}`, JSON.stringify(connection), connection.updatedAt);
    this.save(connection, connection.updatedAt);
  }
}
