import type { AdapterEvent } from "../types.js";
import type { KimiAcpParseState } from "./acp-events.js";

/** Splits one Kimi ACP turn into message/reasoning segments at tool boundaries. */
export class KimiAcpTurnSegments {
  private messageText = "";
  private thinkingText = "";
  private messageIndex = 1;
  private thinkingIndex = 1;

  constructor(private readonly parseState: KimiAcpParseState) {}

  flushBefore(events: AdapterEvent[]): AdapterEvent[] {
    const toolStarted = events.some((event) => event.kind === "tool" && event.phase === "started");
    const answerStarted = events.some((event) => event.kind === "message" && event.phase === "delta");
    if (toolStarted) return [...this.flushMessage(), ...this.flushThinking()];
    if (answerStarted) return this.flushThinking();
    return [];
  }

  append(event: AdapterEvent): void {
    if (event.kind === "message" && event.phase === "delta") this.messageText += event.text;
    if (event.kind === "thinking" && event.phase === "delta") this.thinkingText += event.text;
  }

  flushMessage(): AdapterEvent[] {
    if (!this.messageText) return [];
    const completed: AdapterEvent = {
      kind: "message",
      phase: "completed",
      messageId: this.parseState.messageId,
      text: this.messageText
    };
    this.messageText = "";
    this.messageIndex += 1;
    this.parseState.messageId = `kimi-message-${this.messageIndex}`;
    return [completed];
  }

  flushThinking(): AdapterEvent[] {
    if (!this.thinkingText) return [];
    const completed: AdapterEvent = {
      kind: "thinking",
      phase: "completed",
      messageId: this.parseState.thinkingId,
      text: this.thinkingText
    };
    this.thinkingText = "";
    this.thinkingIndex += 1;
    this.parseState.thinkingId = `kimi-thinking-${this.thinkingIndex}`;
    return [completed];
  }
}
