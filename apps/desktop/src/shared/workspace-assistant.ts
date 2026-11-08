import type { AssistantSession } from "@agenthub/schemas";

export interface AssistantSettings {
  connectionId: string;
  model: string;
  maxSteps: number;
  reasoningEffort?: string;
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
}
export interface AssistantBridge {
  view(before?: number): Promise<AssistantView>;
  configure(settings: AssistantSettings): Promise<void>;
  submit(id: string, text: string): Promise<void>;
  stop(id: string): Promise<void>;
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
