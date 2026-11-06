import type { TimelineEvent } from "./types";
import { useComposerDraftsStore } from "../stores/composer-drafts";

/** Extension state is keyed by its native key, so updates replace a widget. */
export function providerUiState(events: TimelineEvent[]): { statuses: string[]; widgets: string[]; title?: string } {
  const statuses = new Map<string, string>();
  const widgets = new Map<string, string>();
  let title: string | undefined;
  for (const { data } of events) {
    if (data.kind !== "provider_ui") continue;
    if (data.method === "setStatus") statuses.set(data.key ?? "default", data.text);
    if (data.method === "setWidget") widgets.set(data.key ?? "default", data.text);
    if (data.method === "setTitle") title = data.text;
  }
  return { statuses: [...statuses.values()].filter(Boolean), widgets: [...widgets.values()].filter(Boolean), title };
}

const received = new Set<string>();
/** Only called on the live feed, never during historical replay. */
export function applyLiveProviderUi(sessionId: string, event: { eventId: string; type: string; payload: unknown }): void {
  if (event.type !== "provider.extension_ui" || received.has(event.eventId)) return;
  received.add(event.eventId);
  if (received.size > 4096) received.delete(received.values().next().value!);
  const payload = event.payload as { method?: string; text?: string };
  if (["set_editor_text", "setEditorText"].includes(payload.method ?? "") && typeof payload.text === "string") {
    useComposerDraftsStore.getState().setText(sessionId, payload.text);
  }
}
