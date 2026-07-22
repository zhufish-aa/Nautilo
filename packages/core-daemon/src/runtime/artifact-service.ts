import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Artifact } from "@agenthub/domain";
import { Database } from "../database/index.js";

export class ArtifactService {
  constructor(private readonly database: Database) {}
  save(input: Omit<Artifact, "id" | "contentHash"> & { content: string }): Artifact {
    const artifact: Artifact = {
      ...input,
      id: randomUUID(),
      contentHash: createHash("sha256").update(input.content).digest("hex")
    };
    this.database.artifacts.save(artifact, new Date().toISOString(), Buffer.byteLength(input.content));
    return artifact;
  }

  async saveFileReference(input: Omit<Artifact, "id" | "contentHash" | "content"> & { path: string }): Promise<Artifact> {
    const [contentHash, file] = await Promise.all([hashFile(input.path), stat(input.path)]);
    const artifact: Artifact = { ...input, id: randomUUID(), contentHash };
    this.database.artifacts.save(artifact, new Date().toISOString(), file.size);
    return artifact;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
