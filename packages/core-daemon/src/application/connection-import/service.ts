import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { RuntimeConnection } from "@agenthub/domain";
import type { NativeConnectionScan, NativeConnectionImportResult, IpcRequestMap } from "@agenthub/schemas";
import { ConnectionService } from "../connection-service.js";
import { CredentialService } from "../../runtime/security/credential-service.js";
import { connectionCredentialId } from "../../runtime/runtime-connection.js";
import { CoreError } from "../../errors.js";
import { Documents } from "./documents.js";
import { nativeLocations } from "./locations.js";
import { discover } from "./discovery.js";
import type { Candidate } from "./parsers.js";

export function deduplicate(candidates: Candidate[]): Candidate[] {
  const result: Candidate[] = [];
  for (const candidate of candidates) {
    candidate.public.models = [...new Map(candidate.public.models.map(m => [m.id, m])).values()];
    const same = result.find(c => c.public.protocol === candidate.public.protocol && c.public.baseUrl.replace(/\/+$/, "") === candidate.public.baseUrl.replace(/\/+$/, "") && c.secret === candidate.secret);
    if (!same) { result.push(candidate); continue; }
    same.public.sources = [...new Map([...same.public.sources, ...candidate.public.sources].map(s => [JSON.stringify(s), s])).values()];
    same.public.models = [...new Map([...same.public.models, ...candidate.public.models].map(m => [m.id, m])).values()].slice(0, 500);
    if (same.public.models.length) same.public.warnings = same.public.warnings.filter(w => w !== "MODELS_MISSING");
  }
  return result;
}
export class ConnectionImportService {
  private readonly scans = new Map<string, { created: number; candidates: Candidate[] }>();
  constructor(private readonly connections: ConnectionService, private readonly credentials: CredentialService) {}
  scan(home = homedir(), env = process.env): NativeConnectionScan {
    const docs = new Documents(env), connections = this.connections.list();
    const candidates = deduplicate(discover(docs, nativeLocations(home, env, connections), home));
    for (const candidate of candidates) candidate.public.existingConnectionId = this.existing(candidate, connections)?.id;
    const now = Date.now(), scanId = randomUUID();
    for (const [id, scan] of this.scans) if (now - scan.created > 600000) this.scans.delete(id);
    if (this.scans.size >= 4) this.scans.delete(this.scans.keys().next().value!);
    this.scans.set(scanId, { created: now, candidates });
    return { scanId, expiresAt: new Date(now + 600000).toISOString(), candidates: structuredClone(candidates.map(c => c.public)), sources: docs.reports };
  }
  private existing(candidate: Candidate, connections: RuntimeConnection[]): RuntimeConnection | undefined {
    return connections.find(c => c.kind === "api" && c.protocol === candidate.public.protocol && c.baseUrl?.replace(/\/+$/, "") === candidate.public.baseUrl.replace(/\/+$/, "") && this.credentials.read(connectionCredentialId(c.id, c.revision))?.apiKey === candidate.secret);
  }
  import(input: IpcRequestMap["connection.importNative"]["input"]): NativeConnectionImportResult {
    const scan = this.scans.get(input.scanId);
    if (!scan || Date.now() - scan.created > 600000) throw new CoreError("IPC_INVALID_REQUEST", { reason: "SCAN_EXPIRED" });
    if (!Array.isArray(input.candidateIds) || !input.candidateIds.length || input.candidateIds.length > 256 || input.candidateIds.some(id => !scan.candidates.some(c => c.public.id === id))) throw new CoreError("IPC_INVALID_REQUEST", { field: "candidateIds" });
    return { items: [...new Set(input.candidateIds)].map(id => {
      const candidate = scan.candidates.find(c => c.public.id === id)!;
      const existing = this.existing(candidate, this.connections.list());
      if (existing) return { candidateId: id, status: "existing", connection: existing };
      try {
        const c = candidate.public;
        const connection = this.connections.upsert({ connection: { id: `connection-${randomUUID()}`, name: c.name, kind: "api", enabled: true, protocol: c.protocol, baseUrl: c.baseUrl, models: c.models }, apiKey: candidate.secret });
        return { candidateId: id, status: "imported", connection };
      } catch { return { candidateId: id, status: "failed", error: "IMPORT_FAILED" }; }
    }) };
  }
}
