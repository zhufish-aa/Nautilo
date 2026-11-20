import { getBridge, requestCore } from "./bridge";
import { DraftJournal, type DraftRecord } from "./draft-journal";
import { restoreComposerDraft, serializeComposerDraft, setComposerSubmissionPreparation, useComposerDraftsStore, type StoredComposerDraft } from "../stores/composer-drafts";

let journal: DraftJournal | undefined;
let initialization: Promise<void> | undefined;
let observing = false;
let closeGuardInstalled = false;

function report(id: string, error?: string): void {
  const errors = { ...useComposerDraftsStore.getState().persistenceErrors };
  if (error) errors[id] = error; else delete errors[id];
  useComposerDraftsStore.setState({ persistenceErrors: errors });
}

/** The daemon, not localStorage, owns encrypted prompt/attachment persistence. */
export function startComposerPersistence(): Promise<void> {
  if (!getBridge()) return Promise.resolve();
  initialization ??= (async () => {
    const baseline = useComposerDraftsStore.getState();
    const health = await requestCore<{ features?: { composerDrafts?: number } }>("health.get");
    if (health.features?.composerDrafts !== 1) return;
    const restore = (record: DraftRecord, initial = baseline): void => restoreComposerDraft(record.id, record.value as unknown as StoredComposerDraft | null, record.acceptedMessageIds, initial);
    journal ??= new DraftJournal({
      list: () => requestCore("composerDraft.list"),
      write: (id, revision, value) => requestCore("composerDraft.write", { id, revision, value })
    }, id => serializeComposerDraft(useComposerDraftsStore.getState(), id) as unknown as DraftRecord["value"],
    record => restore(record), report);
    const activeJournal = journal;
    if (!observing) { observing = true; useComposerDraftsStore.subscribe((state, previous) => {
      const keys = new Set([...Object.keys(state.drafts), ...Object.keys(previous.drafts), ...Object.keys(state.pending), ...Object.keys(previous.pending), ...Object.keys(state.failed), ...Object.keys(previous.failed)]);
      for (const id of keys) if (state.drafts[id] !== previous.drafts[id] || state.pending[id] !== previous.pending[id] || state.failed[id] !== previous.failed[id]) activeJournal.changed(id);
    }); }
    // Persist even input typed while the vault was loading; restoration checks
    // the original references and never replaces those newer edits.
    for (const id of new Set([...Object.keys(baseline.drafts), ...Object.keys(useComposerDraftsStore.getState().drafts)])) activeJournal.changed(id);
    await activeJournal.start();
    if (closeGuardInstalled) return;
    closeGuardInstalled = true;
    document.addEventListener("visibilitychange", () => { if (document.hidden) void activeJournal.flushAll().catch(() => {}); });
    const windowBridge = getBridge()?.window;
    windowBridge?.onDraftClose?.(id => {
      void activeJournal.flushAll().then(
        () => windowBridge.finishDraftClose?.(id, true),
        () => windowBridge.finishDraftClose?.(id, false)
      ).catch(() => {});
    });
    window.addEventListener("pagehide", () => { void activeJournal.flushAll().catch(() => {}); });
  })().catch(error => { initialization = undefined; throw error; });
  return initialization;
}

setComposerSubmissionPreparation(async submission => {
  await startComposerPersistence();
  if (journal) {
    journal.changed(submission.key);
    await journal.flush(submission.key);
  }
  // A late daemon acknowledgement may arrive after a send timed out. Reconcile
  // only explicit retries; normal sends do not pay for a second vault read.
  const retry = useComposerDraftsStore.getState().failed[submission.key]?.some(entry => entry.submission.messageId === submission.messageId);
  if (journal && retry && !submission.editMessageId) {
    const page = await requestCore<{ items: DraftRecord[] }>("composerDraft.list");
    if (page.items.find(item => item.id === submission.key)?.acceptedMessageIds.includes(submission.messageId)) return "accepted";
  }
  // Restored file references may have been moved while Nautilo was closed.
  // Validate after receipt reconciliation: an accepted send needs no attachment
  // reread and must never be submitted twice just because a file disappeared.
  const bridge = getBridge();
  if (bridge && submission.draft.attachments.length) {
    const missing: string[] = [];
    await Promise.all(submission.draft.attachments.map(async file => {
      try { const files = await bridge.attachments.describePaths([file.path]); if (!files.length) missing.push(file.name); }
      catch { missing.push(file.name); }
    }));
    if (missing.length) throw new Error(`附件无法读取，输入已保留，请重新选择：${missing.join("、")} / Attachment unavailable`);
  }
});

export async function retryComposerDraftSave(id: string, keepLocal = true): Promise<void> {
  await startComposerPersistence();
  if (!journal) return;
  // A user initiated reload uses today's local references as the replacement
  // baseline, rather than the one captured at application startup.
  if (!keepLocal) {
    const page = await requestCore<{ items: DraftRecord[] }>("composerDraft.list");
    const record = page.items.find(item => item.id === id);
    if (record) restoreComposerDraft(id, record.value as unknown as StoredComposerDraft | null, record.acceptedMessageIds, useComposerDraftsStore.getState());
  }
  await journal.resolve(id, true);
}
