export type DiagnosticState = "passed" | "warning" | "failed";
export type DiagnosticStage = "configuration" | "credential" | "catalog" | "launch" | "initialize" | "tools";
export interface DiagnosticStep {
  id: DiagnosticStage;
  state: DiagnosticState;
  elapsedMs: number;
  code?: string;
  message?: string;
}
/** A scoped observation, never a claim that every native harness can use a service. */
export interface ServiceDiagnostic {
  subjectId: string;
  configurationVersion: string;
  scope: "api_catalog" | "account_catalog" | "mcp_handshake";
  state: DiagnosticState;
  checkedAt: string;
  elapsedMs: number;
  steps: DiagnosticStep[];
  tools?: Array<{ name: string; description?: string }>;
  toolCount?: number;
  modelCount?: number;
  protocolVersion?: string;
  serverName?: string;
  truncated?: boolean;
}
