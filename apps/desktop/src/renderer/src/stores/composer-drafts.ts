import { create } from "zustand";
import type { DesktopAttachment } from "../types/bridge";

export interface ComposerDraft {
  text: string;
  attachments: DesktopAttachment[];
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = { text: "", attachments: [] };

type AttachmentUpdate = DesktopAttachment[] | ((current: DesktopAttachment[]) => DesktopAttachment[]);
interface ComposerDraftsState {
  /** Memory only: draft attachment paths and prompts never go to localStorage. */
  drafts: Record<string, ComposerDraft>;
  setText: (id: string, text: string) => void;
  setAttachments: (id: string, next: AttachmentUpdate) => void;
  clear: (id: string) => void;
}

function updatedDrafts(drafts: Record<string, ComposerDraft>, id: string, draft: ComposerDraft): Record<string, ComposerDraft> {
  if (draft.text || draft.attachments.length) return { ...drafts, [id]: draft };
  if (!(id in drafts)) return drafts;
  const next = { ...drafts };
  delete next[id];
  return next;
}

/** Shared by the kept-alive Code/Work panes and their new-conversation forms.
 * Empty/sent drafts are pruned; unsent work is never evicted behind the user. */
export const useComposerDraftsStore = create<ComposerDraftsState>()((set) => ({
  drafts: {},
  setText: (id, text) => set((state) => {
    const current = state.drafts[id] ?? EMPTY_COMPOSER_DRAFT;
    if (current.text === text) return state;
    return { drafts: updatedDrafts(state.drafts, id, { ...current, text }) };
  }),
  setAttachments: (id, next) => set((state) => {
    const current = state.drafts[id] ?? EMPTY_COMPOSER_DRAFT;
    const attachments = typeof next === "function" ? next(current.attachments) : next;
    if (current.attachments === attachments) return state;
    return { drafts: updatedDrafts(state.drafts, id, { ...current, attachments }) };
  }),
  clear: (id) => set((state) => ({ drafts: updatedDrafts(state.drafts, id, EMPTY_COMPOSER_DRAFT) }))
}));
