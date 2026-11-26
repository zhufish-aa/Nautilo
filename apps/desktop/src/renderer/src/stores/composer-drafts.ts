import { create } from "zustand";
import type { CapabilityReference, WorkflowMention } from "@agenthub/domain";
import type { DesktopAttachment } from "../types/bridge";

export interface ComposerDraft {
  text: string;
  attachments: DesktopAttachment[];
  workflow?: WorkflowMention;
  references?: CapabilityReference[];
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = { text: "", attachments: [] };

type AttachmentUpdate = DesktopAttachment[] | ((current: DesktopAttachment[]) => DesktopAttachment[]);
export interface ComposerSubmission {
  token: number;
  messageId: string;
  sourceKey: string;
  key: string;
  draft: ComposerDraft;
  kind: "message" | "steer" | "queue";
  editMessageId?: string;
}
export interface FailedComposerSubmission { submission: ComposerSubmission; error: string }
let nextToken = 0;
interface ComposerDraftsState {
  persistenceErrors: Record<string, string>;
  pending: Record<string, ComposerSubmission>;
  failed: Record<string, FailedComposerSubmission[]>;
  begin: (id: string, kind: ComposerSubmission["kind"], editMessageId?: string, retryToken?: number) => ComposerSubmission | undefined;
  move: (submission: ComposerSubmission, destination: string) => ComposerSubmission;
  finish: (submission: ComposerSubmission, error?: string) => void;
  /** Persisted through authenticated IPC into the daemon's encrypted vault. */
  drafts: Record<string, ComposerDraft>;
  setText: (id: string, text: string) => void;
  setAttachments: (id: string, next: AttachmentUpdate) => void;
  setWorkflow: (id: string, workflow?: WorkflowMention) => void;
  setReferences: (id: string, references?: CapabilityReference[]) => void;
  clear: (id: string) => void;
}

function updatedDrafts(drafts: Record<string, ComposerDraft>, id: string, draft: ComposerDraft): Record<string, ComposerDraft> {
  if (draft.text || draft.attachments.length || draft.workflow || draft.references?.length) return { ...drafts, [id]: draft };
  if (!(id in drafts)) return drafts;
  const next = { ...drafts };
  delete next[id];
  return next;
}

/** Shared by the kept-alive Code/Work panes and their new-conversation forms.
 * Empty/sent drafts are pruned; unsent work is never evicted behind the user. */
export const useComposerDraftsStore = create<ComposerDraftsState>()((set, get) => ({
  persistenceErrors: {},
  drafts: {},
  pending: {},
  failed: {},
  begin: (id, kind, editMessageId, retryToken) => {
    const state = get();
    if (state.pending[id]) return undefined;
    const previous = retryToken === undefined
      ? [...(state.failed[id] ?? [])].reverse().find(entry => entry.submission.draft === state.drafts[id])?.submission
      : state.failed[id]?.find((entry) => entry.submission.token === retryToken)?.submission;
    if (retryToken !== undefined && !previous) return undefined;
    const draft = previous?.draft ?? state.drafts[id];
    if (!draft || (!draft.text.trim() && !draft.attachments.length && !draft.workflow && !draft.references?.length)) return undefined;
    const submission: ComposerSubmission = { token: ++nextToken, messageId: previous?.messageId ?? crypto.randomUUID(), sourceKey: id, key: id, draft, kind: previous?.kind ?? kind, editMessageId: previous ? previous.editMessageId : editMessageId };
    set({ pending: { ...state.pending, [id]: submission } });
    return submission;
  },
  move: (submission, destination) => {
    const state = get();
    if (submission.key === destination) {
      if (state.pending[destination]?.token === submission.token && state.pending[destination] !== submission) {
        set({ pending: { ...state.pending, [destination]: submission } });
      }
      return submission;
    }
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
  setWorkflow: (id, workflow) => set((state) => {
    const current = state.drafts[id] ?? EMPTY_COMPOSER_DRAFT;
    return { drafts: updatedDrafts(state.drafts, id, { ...current, workflow }) };
  }),
  setReferences: (id, references) => set((state) => {
    const current = state.drafts[id] ?? EMPTY_COMPOSER_DRAFT;
    return { drafts: updatedDrafts(state.drafts, id, { ...current, references: references?.length ? references : undefined }) };
  }),
  clear: (id) => set((state) => ({ drafts: updatedDrafts(state.drafts, id, EMPTY_COMPOSER_DRAFT) }))
}));

/** Resolve only means accepted by the daemon, not that the agent run finished. */
let prepareSubmission: (submission: ComposerSubmission) => Promise<void | "accepted"> = async () => {};
export function setComposerSubmissionPreparation(prepare: typeof prepareSubmission): void { prepareSubmission = prepare; }

export async function deliverComposerSubmission(submission: ComposerSubmission, send: () => Promise<unknown>): Promise<boolean> {
  try {
    const result = await prepareSubmission(submission);
    if (result !== "accepted") await send();
    useComposerDraftsStore.getState().finish(submission);
    return true;
  } catch (error) {
    useComposerDraftsStore.getState().finish(submission, error instanceof Error ? error.message : String(error));
    return false;
  }
}

export interface StoredComposerDraft {
  draft?: ComposerDraft;
  submissions: (Omit<ComposerSubmission, "token" | "key" | "sourceKey"> & { error?: string })[];
}

function validDraft(value: unknown): value is ComposerDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  if (draft.workflow !== undefined) {
    const workflow = draft.workflow as Partial<WorkflowMention> | null;
    if (!workflow || typeof workflow.id !== "string" || typeof workflow.name !== "string" ||
      !Number.isSafeInteger(workflow.revision) || (workflow.revision ?? 0) < 1) return false;
  }
  if (draft.references !== undefined && (!Array.isArray(draft.references) || draft.references.length > 24 ||
    !draft.references.every(item => item && typeof item.id === "string" && typeof item.name === "string" &&
      (item.kind === "skill" || (item.kind === "mcp" && (item.tool === undefined || typeof item.tool === "string")))))) return false;
  return typeof draft.text === "string" && Array.isArray(draft.attachments) && draft.attachments.every(item => {
    if (!item || typeof item !== "object") return false;
    const file = item as Record<string, unknown>;
    return typeof file.path === "string" && typeof file.name === "string" &&
      (file.kind === "image" || file.kind === "file") && typeof file.sizeBytes === "number" && Number.isFinite(file.sizeBytes) && file.sizeBytes >= 0 &&
      (file.mimeType === undefined || typeof file.mimeType === "string");
  });
}

function validStoredDraft(value: unknown): value is StoredComposerDraft | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const saved = value as Record<string, unknown>;
  return (saved.draft === undefined || validDraft(saved.draft)) && Array.isArray(saved.submissions) && saved.submissions.every(item => {
    if (!item || typeof item !== "object") return false;
    const submission = item as Record<string, unknown>;
    return typeof submission.messageId === "string" && !!submission.messageId && validDraft(submission.draft) &&
      ["message", "steer", "queue"].includes(submission.kind as string) &&
      (submission.editMessageId === undefined || typeof submission.editMessageId === "string") &&
      (submission.error === undefined || typeof submission.error === "string");
  });
}

export function serializeComposerDraft(state: ComposerDraftsState, id: string): StoredComposerDraft | null {
  const pending = state.pending[id];
  const submissions: StoredComposerDraft["submissions"] = (state.failed[id] ?? []).filter(entry => entry.submission.messageId !== pending?.messageId)
    .map(entry => ({ ...entry.submission, error: entry.error }));
  if (pending?.key === id) submissions.push(pending);
  if (!state.drafts[id] && !submissions.length) return null;
  return {
    draft: state.drafts[id],
    submissions: submissions.map(({ messageId, draft, kind, editMessageId, ...rest }) => ({ messageId, draft, kind, editMessageId, error: "error" in rest ? rest.error as string : undefined }))
  };
}

/** A recovery never sends anything. Accepted IDs suppress an ambiguous, already
 * delivered submission; unresolved sends remain explicit retry entries. */
export function restoreComposerDraft(id: string, value: StoredComposerDraft | null, accepted: readonly string[], baseline: ComposerDraftsState): void {
  if (!validStoredDraft(value)) throw new Error("Invalid saved composer draft");
  const current = useComposerDraftsStore.getState();
  if (current.drafts[id] !== baseline.drafts[id] || current.pending[id] !== baseline.pending[id] || current.failed[id] !== baseline.failed[id]) return;
  let draft = value?.draft;
  const failed: FailedComposerSubmission[] = [];
  for (const saved of value?.submissions ?? []) {
    if (accepted.includes(saved.messageId)) {
      if (draft && JSON.stringify(draft) === JSON.stringify(saved.draft)) draft = undefined;
      continue;
    }
    if (draft && JSON.stringify(draft) === JSON.stringify(saved.draft)) draft = saved.draft;
    failed.push({ submission: { ...saved, key: id, sourceKey: id, token: ++nextToken }, error: saved.error ?? "上次发送结果未确认；内容已保留，请确认后重试。 / Previous send was not confirmed. Review before retrying." });
  }
  const drafts = { ...current.drafts };
  if (draft) drafts[id] = draft; else delete drafts[id];
  const failures = { ...current.failed };
  if (failed.length) failures[id] = failed; else delete failures[id];
  useComposerDraftsStore.setState({ drafts, failed: failures });
}
