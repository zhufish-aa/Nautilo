import { create } from "zustand";
import type { DesktopAttachment } from "../types/bridge";

export interface ComposerDraft {
  text: string;
  attachments: DesktopAttachment[];
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = { text: "", attachments: [] };

type AttachmentUpdate = DesktopAttachment[] | ((current: DesktopAttachment[]) => DesktopAttachment[]);
export interface ComposerSubmission {
  token: number;
  sourceKey: string;
  key: string;
  draft: ComposerDraft;
  kind: "message" | "steer" | "queue";
  editMessageId?: string;
}
export interface FailedComposerSubmission { submission: ComposerSubmission; error: string }
let nextToken = 0;
interface ComposerDraftsState {
  pending: Record<string, ComposerSubmission>;
  failed: Record<string, FailedComposerSubmission[]>;
  begin: (id: string, kind: ComposerSubmission["kind"], editMessageId?: string, retryToken?: number) => ComposerSubmission | undefined;
  move: (submission: ComposerSubmission, destination: string) => ComposerSubmission;
  finish: (submission: ComposerSubmission, error?: string) => void;
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
export const useComposerDraftsStore = create<ComposerDraftsState>()((set, get) => ({
  drafts: {},
  pending: {},
  failed: {},
  begin: (id, kind, editMessageId, retryToken) => {
    const state = get();
    if (state.pending[id]) return undefined;
    const previous = retryToken === undefined ? undefined : state.failed[id]?.find((entry) => entry.submission.token === retryToken)?.submission;
    if (retryToken !== undefined && !previous) return undefined;
    const draft = previous?.draft ?? state.drafts[id];
    if (!draft || (!draft.text.trim() && !draft.attachments.length)) return undefined;
    const submission: ComposerSubmission = { token: ++nextToken, sourceKey: id, key: id, draft, kind: previous?.kind ?? kind, editMessageId: previous ? previous.editMessageId : editMessageId };
    set({ pending: { ...state.pending, [id]: submission } });
    return submission;
  },
  move: (submission, destination) => {
    if (submission.key === destination) return submission;
    const state = get();
    if (state.pending[submission.key]?.token !== submission.token || state.pending[destination]) throw new Error("Submission destination is unavailable");
    const moved = { ...submission, key: destination };
    let drafts = state.drafts;
    if (drafts[submission.sourceKey] === submission.draft) drafts = updatedDrafts(drafts, submission.sourceKey, EMPTY_COMPOSER_DRAFT);
    // New sessions are empty. Never replace a draft already entered there.
    if (!drafts[destination]) drafts = { ...drafts, [destination]: submission.draft };
    set({ drafts, pending: { ...state.pending, [submission.sourceKey]: moved, [destination]: moved } });
    return moved;
  },
  finish: (submission, error) => set((state) => {
    if (state.pending[submission.key]?.token !== submission.token) return state;
    const pending = { ...state.pending };
    delete pending[submission.key];
    if (pending[submission.sourceKey]?.token === submission.token) delete pending[submission.sourceKey];
    const failed = { ...state.failed };
    const remaining = (failed[submission.key] ?? []).filter((entry) => entry.submission.draft !== submission.draft);
    if (error !== undefined) remaining.push({ submission, error });
    if (remaining.length) failed[submission.key] = remaining;
    else delete failed[submission.key];
    // Referential comparison is a version check: even edits back to the same
    // text are newer user intent and must not be erased by an old response.
    const drafts = error === undefined && state.drafts[submission.key] === submission.draft
      ? updatedDrafts(state.drafts, submission.key, EMPTY_COMPOSER_DRAFT) : state.drafts;
    return { drafts, pending, failed };
  }),
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

/** Resolve only means accepted by the daemon, not that the agent run finished. */
export async function deliverComposerSubmission(submission: ComposerSubmission, send: () => Promise<unknown>): Promise<boolean> {
  try {
    await send();
    useComposerDraftsStore.getState().finish(submission);
    return true;
  } catch (error) {
    useComposerDraftsStore.getState().finish(submission, error instanceof Error ? error.message : String(error));
    return false;
  }
}
