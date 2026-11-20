import type { Database } from "../database/index.js";
import type { CredentialService } from "../runtime/security/credential-service.js";
import { CoreError } from "../errors.js";

export class ComposerDraftService {
  constructor(private readonly database: Database, private readonly vault: CredentialService) {}
  list() {
    const unreadable: string[] = [];
    const items = this.database.composerDrafts.list().flatMap(({ id, revision, encrypted }) => {
      try {
        const value = encrypted === null ? null : this.vault.decryptPayload(encrypted) as Record<string, unknown>;
        const submissions = Array.isArray(value?.submissions) ? value.submissions as { messageId?: string }[] : [];
        const ids = submissions.flatMap(s => typeof s.messageId === "string" ? [s.messageId] : []).slice(0, 100);
        return [{ id, revision, value, acceptedMessageIds: this.database.composerDrafts.acceptedMessages(id, ids) }];
      } catch { unreadable.push(id); return []; }
    });
    return { items, unreadable };
  }
  write(input: { id: string; revision: number; value: Record<string, unknown> | null }) {
    if (!input || typeof input.id !== "string" || !input.id.length || Buffer.byteLength(input.id) > 512 ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision >= Number.MAX_SAFE_INTEGER ||
      (input.value !== null && (!input.value || typeof input.value !== "object" || Array.isArray(input.value))) || Buffer.byteLength(JSON.stringify(input.value)) > 1_048_576) {
      throw new CoreError("IPC_INVALID_REQUEST", { field: "composerDraft" });
    }
    return this.database.composerDrafts.write(input.id, input.revision, input.value === null ? null : this.vault.encryptPayload(input.value));
  }
}
