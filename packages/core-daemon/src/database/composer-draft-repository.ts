import type { DatabaseSync } from "node:sqlite";

type Encrypted = { iv: string; tag: string; ciphertext: string };
export class ComposerDraftRepository {
  constructor(private readonly db: DatabaseSync) {}
  list(): { id: string; revision: number; encrypted: Encrypted | null }[] {
    return (this.db.prepare("SELECT id,revision,data FROM composer_drafts").all() as { id: string; revision: number; data: string }[])
      .map(({ id, revision, data }) => {
        // A corrupt row is reported individually, never treated as an empty draft.
        try { return { id, revision, encrypted: JSON.parse(data) as Encrypted | null }; }
        catch { return { id, revision, encrypted: { iv: "", tag: "", ciphertext: "invalid" } }; }
      });
  }
  write(id: string, revision: number, encrypted: Encrypted | null): { saved: boolean; revision: number } {
    const data = JSON.stringify(encrypted);
    const result = revision === 0
      ? this.db.prepare("INSERT OR IGNORE INTO composer_drafts(id,revision,data) VALUES(?,1,?)").run(id, data)
      : this.db.prepare("UPDATE composer_drafts SET revision=revision+1,data=? WHERE id=? AND revision=?").run(data, id, revision);
    return { saved: result.changes === 1, revision: revision + (result.changes === 1 ? 1 : 0) };
  }
  acceptedMessages(sessionId: string, ids: string[]): string[] {
    const query = this.db.prepare("SELECT id FROM messages WHERE id=? AND session_id=?");
    return ids.filter(id => !!query.get(id, sessionId));
  }
}
