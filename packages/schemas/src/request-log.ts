/** Timings are observations of one native turn, not inferred network timings. */
export type RequestMilestone =
  | "queued"
  | "preparing"
  | "prepared"
  | "dispatched"
  | "runtimeReady"
  | "firstEvent"
  | "firstThinking"
  | "firstText"
  | "ended";
export interface RequestLog {
  id: string;
  sessionId: string;
  projectId: string;
  agentInstanceId: string;
  providerId: string;
  connectionId?: string;
  connectionRevision?: number;
  model?: string;
  runId?: string;
  messageId?: string;
  operation: string;
  createdAt: string;
  updatedAt: string;
  status:
    | "queued"
    | "preparing"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  /** Elapsed milliseconds from admission, measured on a monotonic clock. Missing means unobserved. */
  milestones: Partial<Record<RequestMilestone, number>>;
  failure?: { stage: string; code?: string; message: string };
  runtime?: {
    reused?: boolean;
    pid?: number;
    attachMs?: number;
    startupTimings?: {
      prepareMs: number;
      bootstrapMs: number;
      sessionOpenMs: number;
      openDetails?: {
        providerBindMs: number;
        sessionCreateMs: number;
        agentResolveMs: number;
        preferencesMs: number;
        loaderWaitMs?: number;
        providerUpdateMs?: number;
        pendingPlugins?: string[];
      };
    };
  };
  suppliedTools: string[];
  suppliedServers: string[];
  observedTools: string[];
  nativeTools?: string[];
  nativeServers?: Array<{ name: string; status?: string }>;
}
export interface RequestLogQuery {
  sessionId?: string;
  providerId?: string;
  status?: string;
  before?: string;
  limit?: number;
}
export interface RequestLogPage {
  items: RequestLog[];
  nextCursor?: string;
}
export interface SessionToolInventory {
  sessionId: string;
  checkedAt: string;
  requestId?: string;
  nativeReported: boolean;
  tools: Array<{ name: string; evidence: "native" | "observed" | "supplied" }>;
  servers: Array<{
    name: string;
    evidence: "native" | "supplied";
    status?: string;
  }>;
}
