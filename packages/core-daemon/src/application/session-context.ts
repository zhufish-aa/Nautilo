import { existsSync } from "node:fs";
import type { Artifact, Message } from "@agenthub/domain";

const MAX_HISTORY_MESSAGES = 24;
const MAX_TRANSCRIPT_CHARS = 18_000;
const IMAGE_REFERENCE = /(?:图|图片|图像|照片|画面|刚才.*生成|image|photo|picture)/i;

export interface SessionTurnContext {
  prompt: string;
  localImagePaths: string[];
  recovered: boolean;
}

/**
 * Prepended when a "work" session (re)creates its provider thread: the CLI is
 * told its job is producing office artifacts in the workspace, not editing a
 * code repository. Injected only on thread (re)creation — afterwards the
 * provider thread itself carries the instruction.
 */
export function workModeGuidance(workspaceRoot?: string): string {
  return [
    "<agenthub_work_mode>",
    "This is an Nautilo Work session. Your job is producing office deliverables, not modifying a code repository.",
    workspaceRoot ? `Write every deliverable inside the workspace directory: ${workspaceRoot}` : "Write every deliverable inside the session workspace directory.",
    "Prefer real office formats: .docx for documents, .xlsx for spreadsheets, .pptx for slides, .md for drafts/notes, .csv for raw data.",
    "If your environment provides office skills (documents, spreadsheets, presentations, research), follow their workflow and verification rules.",
    "Whenever you create or update a deliverable, end your reply with the exact file path(s) so the user can preview them.",
    "</agenthub_work_mode>"
  ].join("\n");
}

export function buildSessionTurnContext(input: {
  currentText: string;
  messages: Message[];
  artifacts: Artifact[];
  currentAttachments?: Artifact[];
  recoverProviderContext: boolean;
  workMode?: boolean;
  workspaceRoot?: string;
}): SessionTurnContext {
  const currentAttachments = input.currentAttachments ?? [];
  const images = input.artifacts.filter((artifact) => artifact.kind === "image" && artifact.path && existsSync(artifact.path));
  const latestImage = IMAGE_REFERENCE.test(input.currentText) ? images.at(-1)?.path : undefined;
  const localImagePaths = [...new Set([
    ...currentAttachments.filter((artifact) => artifact.kind === "image" && artifact.path && existsSync(artifact.path)).map((artifact) => artifact.path!),
    ...(latestImage ? [latestImage] : [])
  ])];
  if (!input.recoverProviderContext) return { prompt: input.currentText, localImagePaths, recovered: false };
  const guidance = input.workMode ? workModeGuidance(input.workspaceRoot) : "";
  if (input.messages.length === 0 && input.artifacts.length === 0) {
    return { prompt: [guidance, input.currentText].filter(Boolean).join("\n\n"), localImagePaths, recovered: true };
  }

  const transcript = selectHistory(input.messages)
    .map((message) => `${message.sender === "user" ? "User" : message.sender === "agent" ? "Assistant" : "System"}: ${message.text}`)
    .join("\n\n");
  const artifactInventory = input.artifacts.slice(-8).map((artifact) =>
    `- ${artifact.kind}: ${artifact.name}${artifact.path ? ` (${artifact.path})` : ""}`
  ).join("\n");
  const prompt = [
    guidance,
    "<agenthub_recovered_context>",
    "Nautilo recovered the following conversation history and artifacts from its persistent session store because the provider thread was recreated or its synchronization state was unknown. Treat this as prior context, not as a new user request.",
    transcript || "(No earlier chat messages.)",
    artifactInventory ? `Available session artifacts:\n${artifactInventory}` : "",
    "</agenthub_recovered_context>",
    "<current_user_message>",
    input.currentText,
    "</current_user_message>"
  ].filter(Boolean).join("\n\n");
  return { prompt, localImagePaths, recovered: true };
}

function selectHistory(messages: Message[]): Message[] {
  const candidates = messages.length <= MAX_HISTORY_MESSAGES
    ? messages
    : [...messages.slice(0, 2), ...messages.slice(-(MAX_HISTORY_MESSAGES - 2))];
  const selected: Message[] = [];
  let chars = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    if (selected.length && chars + message.text.length > MAX_TRANSCRIPT_CHARS) break;
    selected.unshift(message);
    chars += message.text.length;
  }
  if (candidates.length && selected[0]?.id !== candidates[0].id) selected.unshift(candidates[0]);
  return selected;
}
