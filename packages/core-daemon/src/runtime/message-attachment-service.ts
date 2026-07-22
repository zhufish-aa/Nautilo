import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Artifact, Session } from "@agenthub/domain";
import type { MessageAttachmentInput } from "@agenthub/schemas";
import { Database } from "../database/index.js";
import { CoreError } from "../errors.js";
import { ArtifactService } from "./artifact-service.js";

const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** Validates user-selected files and persists immutable artifact references. */
export class MessageAttachmentService {
  private readonly artifacts: ArtifactService;

  constructor(private readonly database: Database) {
    this.artifacts = new ArtifactService(database);
  }

  async save(session: Session, inputs: MessageAttachmentInput[] = []): Promise<Artifact[]> {
    if (inputs.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new CoreError("IPC_INVALID_REQUEST", { field: "attachments", max: MAX_ATTACHMENTS_PER_MESSAGE });
    }
    const saved: Artifact[] = [];
    for (const input of inputs) {
      if (!isAbsolute(input.path)) throw new CoreError("IPC_INVALID_REQUEST", { field: "attachments.path", path: input.path });
      const path = await realpath(input.path).catch(() => undefined);
      if (!path) throw new CoreError("IPC_INVALID_REQUEST", { field: "attachments.path", path: input.path });
      const file = await stat(path);
      if (!file.isFile() || file.size > MAX_ATTACHMENT_BYTES) {
        throw new CoreError("IPC_INVALID_REQUEST", { field: "attachments", path, sizeBytes: file.size, maxBytes: MAX_ATTACHMENT_BYTES });
      }
      saved.push(await this.artifacts.saveFileReference({
        kind: input.kind,
        name: input.name,
        path,
        sessionId: session.id,
        projectRunId: session.projectRunId,
        taskId: session.taskId,
        metadata: {
          source: "user_attachment",
          sizeBytes: file.size,
          ...(input.mimeType ? { mimeType: input.mimeType } : {})
        }
      }));
    }
    return saved;
  }

  listForRun(projectRunId: string): Artifact[] {
    return this.database.artifacts.list({ projectRunId });
  }
}

export function appendAttachmentContext(text: string, artifacts: Artifact[]): string {
  if (!artifacts.length) return text;
  const inventory = artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.name}${artifact.path ? ` (${artifact.path})` : ""}`).join("\n");
  return [
    text,
    "<agenthub_user_attachments>",
    "The user attached these local files to this message. Inspect them when relevant:",
    inventory,
    "</agenthub_user_attachments>"
  ].join("\n\n");
}
