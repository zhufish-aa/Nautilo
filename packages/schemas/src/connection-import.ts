import type { InstanceModelConfig, RuntimeConnection } from "@agenthub/domain";

export interface NativeConnectionSource { harness: string; path: string; }
export interface NativeConnectionCandidate {
  id: string;
  name: string;
  protocol: "responses" | "chat" | "anthropic";
  baseUrl: string;
  models: InstanceModelConfig[];
  hasCredential: boolean;
  sources: NativeConnectionSource[];
  warnings: string[];
  existingConnectionId?: string;
}
export interface NativeConnectionScan {
  scanId: string;
  expiresAt: string;
  candidates: NativeConnectionCandidate[];
  sources: (NativeConnectionSource & { status: "read" | "error"; error?: string | null })[];
}
export interface NativeConnectionImportResult {
  items: { candidateId: string; status: "imported" | "existing" | "failed"; connection?: RuntimeConnection; error?: string }[];
}
