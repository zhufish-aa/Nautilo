import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;
export interface EncryptedCredential { iv: string; tag: string; ciphertext: string; }

export class CredentialRepository {
  constructor(private readonly db: DatabaseSync) {}
  save(agentInstanceId: string, encrypted: EncryptedCredential): void {
    this.db.prepare("INSERT OR REPLACE INTO credentials(agent_instance_id, data, updated_at) VALUES(?, ?, ?)")
      .run(agentInstanceId, JSON.stringify(encrypted), new Date().toISOString());
  }
  get(agentInstanceId: string): EncryptedCredential | undefined {
    const row = this.db.prepare("SELECT data FROM credentials WHERE agent_instance_id = ?").get(agentInstanceId) as Row | undefined;
    return row ? JSON.parse(String(row.data)) as EncryptedCredential : undefined;
  }
  has(agentInstanceId: string): boolean { return !!this.db.prepare("SELECT 1 AS value FROM credentials WHERE agent_instance_id = ?").get(agentInstanceId); }
  remove(agentInstanceId: string): boolean { return Number(this.db.prepare("DELETE FROM credentials WHERE agent_instance_id = ?").run(agentInstanceId).changes) > 0; }
}
