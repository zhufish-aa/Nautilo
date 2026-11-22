import type { AssistantDispatch, AssistantSession } from "@agenthub/schemas";
import type { RuntimeConnection } from "@agenthub/domain";

export function assistantConnectionAvailable(connection: RuntimeConnection): boolean {
  return connection.enabled && (connection.kind === "api" ? connection.hasCredential !== false : connection.accountGateway === true);
}

export const DEFAULT_ASSISTANT_STEP_LIMIT = 0;

export function isAssistantStepLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export interface AssistantSettings {
  connectionId: string;
  model: string;
  maxSteps: number;
  reasoningEffort?: string;
  proactiveTopics?: boolean;
}
export interface AssistantReceipt {
  sessionId: string;
  title: string;
  project: string;
  task: string;
  created: boolean;
  delivery: "pending" | "sent" | "queued" | "failed";
  runId?: string;
  projectRunId?: string;
  messageId: string;
  error?: string;
}
export interface AssistantTurn {
  id: string;
  at: string;
  text: string;
  status: "queued" | "running" | "done" | "stopped" | "error";
  reply?: string;
  receipts: AssistantReceipt[];
  usage?: { input: number; cached?: number };
  source?: { turnSeq?: number; sessionId?: string; routineId?: string };
  routineDraft?: AssistantRoutineInput;
}
export interface AssistantMemory {
  through: number;
  summary: string;
  at: string;
  destinations?: Array<{ sessionId: string; title: string; project: string }>;
}
export interface JournalRow<T> {
  seq: number;
  value: T;
}
export interface AssistantLiveOutput {
  turnId: string;
  stepId: string;
  text: string;
}
export interface AssistantView {
  liveOutput?: AssistantLiveOutput;
  settings: AssistantSettings;
  turns: JournalRow<AssistantTurn>[];
  memoryAt?: string;
  stage?: string;
  busy: boolean;
  dispatches: AssistantDispatch[];
}

export type AssistantRoutineInput = {
  title: string;
  task: string;
  sessionId: string;
  trigger: { type: "schedule"; at: string; repeat: "once" | "daily" | "weekly" } |
    { type: "github"; repository: string };
};
export interface AssistantRoutine extends AssistantRoutineInput {
  id: string;
  nextAt: number | null;
  paused: boolean;
  cursor?: number;
  latest?: { turnSeq: number; at: string };
  error?: string;
}
export interface AssistantTopic {
  turnId: string;
  turnSeq: number;
  topic: string;
  askedAt: string;
  nextAt: number;
  error?: string;
}
export type AssistantAutomationAction =
  | { type: "save"; data: AssistantRoutineInput; sourceTurnId?: string }
  | { type: "pause" | "resume" | "run" | "remove"; id: string }
  | { type: "history"; id: string }
  | { type: "stopTopic"; id: string };
export interface AssistantAutomationsView {
  routines: AssistantRoutine[];
  topics: AssistantTopic[];
  history?: Array<Pick<JournalRow<AssistantTurn>, "seq"> & { at: string; reply?: string }>;
}
export interface AssistantBridge {
  view(before?: number): Promise<AssistantView>;
  configure(settings: AssistantSettings): Promise<void>;
  submit(id: string, text: string): Promise<void>;
  stop(id: string): Promise<void>;
  automations(action?: AssistantAutomationAction): Promise<AssistantAutomationsView>;
  onOutput(listener: (output: AssistantLiveOutput) => void): () => void;
  onChange(listener: (targetSessionId?: string) => void): () => void;
}
export function activityOf(session: AssistantSession): string {
  if (session.status === "archived") return "archived";
  if (session.status === "waiting_approval" || session.status === "waiting_input") return session.status;
  const latest = session.runStatus;
  if (latest === "waiting_approval" || latest === "waiting_input") return latest;
  if (latest && ["starting", "created", "running", "cancelling"].includes(latest)) return "running";
  if (latest === "completed") return "completed";
  if (latest === "cancelled") return "cancelled";
  if (latest && ["crashed", "failed", "timed_out"].includes(latest)) return "failed";
  return session.status;
}
