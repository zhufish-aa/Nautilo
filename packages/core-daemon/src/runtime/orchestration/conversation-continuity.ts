import { existsSync } from "node:fs";
import type { Artifact, Message } from "@agenthub/domain";

const MAX_MESSAGES = 18;
const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_ARTIFACTS = 12;
const REFERENCES_PRIOR_ARTIFACT = /(?:这|那|刚才|刚刚|上次|上一张|前面|之前).{0,8}(?:图|图片|图像|文件|结果)|(?:this|that|previous|last|earlier).{0,12}(?:image|picture|photo|file|result)/i;

export interface ConversationContinuity {
  prompt?: string;
  localImagePaths: string[];
}

/** Builds a bounded, persistent handoff between separate orchestration turns. */
export class ConversationContinuityBuilder {
  build(input: {
    currentProjectRunId: string;
    currentText: string;
    messages: Message[];
    artifacts: Artifact[];
    recoverProviderContext: boolean;
  }): ConversationContinuity {
    const history = input.recoverProviderContext
      ? input.messages
        .filter((message) => message.projectRunId !== input.currentProjectRunId)
        .filter((message) => message.kind === undefined || message.kind === "chat")
        .slice(-MAX_MESSAGES)
      : [];
    const selected = boundedMessages(history);
    const referencesPriorArtifact = REFERENCES_PRIOR_ARTIFACT.test(input.currentText);
    const currentAttachments = input.artifacts.filter((artifact) =>
      artifact.projectRunId === input.currentProjectRunId && artifact.metadata?.source === "user_attachment"
    );
    const contextualArtifacts = input.recoverProviderContext || referencesPriorArtifact
      ? input.artifacts.slice(-MAX_ARTIFACTS)
      : [];
    const artifacts = [...new Map([...contextualArtifacts, ...currentAttachments].map((artifact) => [artifact.id, artifact])).values()];
    const localImagePaths = artifacts
      .filter((artifact) => artifact.kind === "image" && artifact.path && existsSync(artifact.path))
      .filter((artifact) => currentAttachments.some((current) => current.id === artifact.id) || referencesPriorArtifact)
      .map((artifact) => artifact.path!);

    if (selected.length === 0 && artifacts.length === 0) {
      return { localImagePaths };
    }

    const transcript = selected.map((message) =>
      `${message.sender === "user" ? "User" : message.sender === "agent" ? "Assistant" : "System"}: ${message.text}`
    ).join("\n\n");
    const inventory = artifacts.map((artifact) =>
      `- ${artifact.kind}: ${artifact.name}${artifact.path ? ` (${artifact.path})` : ""}`
    ).join("\n");
    return {
      prompt: [
        "<agenthub_conversation_continuity>",
        input.recoverProviderContext
          ? "The provider session could not be trusted as synchronized, so Nautilo recovered bounded chat history. Treat it as prior context, not a new request."
          : "These are cross-Agent artifacts that are not guaranteed to exist in the main provider session. Use them only to resolve the current follow-up reference.",
        transcript,
        inventory ? `Recent artifacts produced by this chat and its delegated child sessions:\n${inventory}` : "",
        "</agenthub_conversation_continuity>"
      ].filter(Boolean).join("\n\n"),
      localImagePaths
    };
  }
}

function boundedMessages(messages: Message[]): Message[] {
  const selected: Message[] = [];
  let chars = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (selected.length > 0 && chars + message.text.length > MAX_TRANSCRIPT_CHARS) break;
    selected.unshift(message);
    chars += message.text.length;
  }
  return selected;
}
