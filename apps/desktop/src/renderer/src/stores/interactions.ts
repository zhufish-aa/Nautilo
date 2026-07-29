import { create } from "zustand";
import type { InteractionRequest, InteractionResponse } from "@agenthub/domain";
import type { RuntimeEvent } from "@agenthub/event-protocol";
import { getBridge, requestCore } from "../lib/bridge";

/**
 * Provider-initiated questions and approvals (Codex request_user_input, Kimi
 * elicitation, Claude AskUserQuestion). The Core Daemon suspends the provider
 * turn until the desktop user answers; the chat page renders cards from this
 * store. Outside the desktop shell everything degrades to an empty store.
 */
interface InteractionsState {
  bySession: Record<string, InteractionRequest[]>;
  /** Restores unanswered cards when a conversation is (re)opened. */
  loadPending: (sessionId: string) => Promise<void>;
  respond: (interactionId: string, response: InteractionResponse) => Promise<InteractionRequest>;
  _upsert: (interaction: InteractionRequest) => void;
  _removeSessions: (sessionIds: string[]) => void;
}

function upsert(list: InteractionRequest[] | undefined, interaction: InteractionRequest): InteractionRequest[] {
  const current = list ?? [];
  const next = current.some((item) => item.id === interaction.id)
    ? current.map((item) => (item.id === interaction.id ? interaction : item))
    : [...current, interaction];
  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export const useInteractionsStore = create<InteractionsState>((set, get) => ({
  bySession: {},

  loadPending: async (sessionId) => {
    if (!getBridge()) return;
    try {
      const pending = await requestCore<InteractionRequest[]>("interaction.list", { sessionId, status: "pending" });
      for (const interaction of pending) get()._upsert(interaction);
    } catch {
      // A daemon without the interaction API leaves the cards empty.
    }
  },

  respond: async (interactionId, response) => {
    const resolved = await requestCore<InteractionRequest>("interaction.respond", { interactionId, ...response });
    get()._upsert(resolved);
    return resolved;
  },

  _upsert: (interaction) =>
    set((state) => ({
      bySession: {
        ...state.bySession,
        [interaction.sessionId]: upsert(state.bySession[interaction.sessionId], interaction)
      }
    })),

  _removeSessions: (sessionIds) =>
    set((state) => {
      const deleted = new Set(sessionIds);
      return {
        bySession: Object.fromEntries(Object.entries(state.bySession).filter(([id]) => !deleted.has(id)))
      };
    })
}));

/** Feeds interaction lifecycle events from a session event stream into the store. */
export function ingestInteractionEvents(events: RuntimeEvent[]): void {
  const store = useInteractionsStore.getState();
  for (const event of events) {
    if (event.type === "interaction.requested" || event.type === "interaction.resolved") {
      store._upsert(event.payload.interaction);
    }
  }
}
