export interface NativeRuntimeCapabilities {
  schemaVersion: 1;
  providerId: string;
  evidence: { source: "adapter-contract" | "native-handshake"; cliVersion?: string | null; protocolVersion?: string | number };
  session: { transport: string; processReuse: boolean; resume: "native" | "unknown" };
  turn: { interrupt: "native-or-process" | "process"; steer: "native" | "queued" };
  interactions: { dialogs: string[]; nativeTerminal: boolean; unknownRequests: "visible-error" };
  resources: { nativeConfig: "preserved" | "unknown"; managedMcp: "merged" | "unknown"; managedSkills: "merged" | "unknown" };
  negotiated?: { source: "native-handshake"; transport: string; observedAt: string; protocolVersion?: string | number; cliVersion?: string; reported?: unknown };
  lastRuntime?: { transport: string; reused: boolean; pid?: number; attachMs: number; observedAt: string };
}
