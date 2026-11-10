export interface AssistantModelStep {
  connectionId: string;
  model: string;
  instructions: string;
  streamId?: string;
  reasoningEffort?: string;
  context: string[];
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}
export interface AssistantDecision {
  cacheReadTokens?: number | null;
  inputTokens?: number | null;
  text?: string;
  call?: { name: string; arguments: Record<string, unknown> };
}
export interface AssistantLookup {
  projectId?: string;
  sessionId?: string;
  query?: string;
  skip?: number;
  previews?: boolean;
}
export interface AssistantSession {
  id: string;
  title: string;
  projectId: string;
  project: string;
  harness: string;
  status: string;
  runStatus: string | null;
  updatedAt: string;
  preview: string | null;
}
export interface AssistantRead {
  sessionId: string;
  query?: string;
  before?: number;
  messageId?: string;
  offset?: number;
}
export interface AssistantExcerpt {
  id: string;
  sender: string;
  at: string;
  text: string;
  offset: number;
  nextOffset: number | null;
}
export interface AssistantSessionPage {
  items: AssistantSession[];
  next: number | null;
}
export interface AssistantExcerptPage {
  items: AssistantExcerpt[];
  next: number | null;
}
