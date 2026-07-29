/**
 * Provider-initiated user interactions: structured questions (Codex
 * request_user_input, Kimi ACP elicitation, Claude AskUserQuestion) and tool
 * permission prompts. The provider turn blocks until the desktop user responds.
 */
export interface InteractionOption {
  id: string;
  label: string;
  description?: string;
  /**
   * Provider-neutral meaning used by dedicated interaction surfaces. The id
   * remains provider-native so the adapter can return the exact decision its
   * protocol expects.
   */
  intent?: "approve" | "revise" | "reject";
}

export interface InteractionQuestion {
  id: string;
  header?: string;
  question: string;
  /** Predefined choices; absent means free-text input. */
  options?: InteractionOption[];
  multiSelect?: boolean;
  /** The provider offers an "Other" free-text escape hatch. */
  isOther?: boolean;
  /** The answer is a secret and should be masked in the UI. */
  isSecret?: boolean;
}

export interface InteractionPlan {
  /** Markdown plan shown to the user. */
  content: string;
  /** Optional provider-owned plan file, shown as context rather than raw JSON. */
  sourcePath?: string;
}

export type InteractionKind = "question" | "approval" | "plan_approval";

export interface InteractionResponse {
  outcome: "selected" | "cancelled";
  /** Chosen option for kind "approval". */
  optionId?: string;
  /** questionId → selected option labels or free text, for kind "question". */
  answers?: Record<string, string[]>;
}

export interface InteractionRequest {
  id: string;
  sessionId: string;
  runId?: string;
  providerId: string;
  kind: InteractionKind;
  /** Short summary, e.g. the tool name or "运行命令". */
  title: string;
  /** Long detail, e.g. the command line or the provider's reason. */
  detail?: string;
  /** kind "question": the questions to answer. */
  questions?: InteractionQuestion[];
  /** kind "approval": the decisions the user may pick. */
  options?: InteractionOption[];
  /** kind "plan_approval": normalized plan content supplied by the provider. */
  plan?: InteractionPlan;
  status: "pending" | "resolved" | "cancelled";
  response?: InteractionResponse;
  createdAt: string;
  resolvedAt?: string;
}
