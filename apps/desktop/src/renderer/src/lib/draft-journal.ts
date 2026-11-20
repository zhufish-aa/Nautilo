export interface DraftRecord {
  id: string;
  revision: number;
  value: Record<string, unknown> | null;
  acceptedMessageIds: string[];
}

export interface DraftStorage {
  list(): Promise<{ items: DraftRecord[]; unreadable: string[] }>;
  write(id: string, revision: number, value: DraftRecord["value"]): Promise<{ saved: boolean; revision: number }>;
}

/** Per-key write queues avoid old acknowledgements overwriting fresh input.
 * Read failures never mean an empty vault; conflicts never silently win. */
export class DraftJournal {
  private initialization?: Promise<void>;
  private readonly revisions = new Map<string, number>();
  private readonly saved = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private readonly blocked = new Set<string>();
  private readonly writes = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setTimeout>;
  private ready = false;
  constructor(
    private readonly storage: DraftStorage,
    private readonly read: (id: string) => DraftRecord["value"],
    private readonly restore: (record: DraftRecord) => void,
    private readonly report: (id: string, error?: string) => void,
    private readonly delayMs = 180
  ) {}

  start(): Promise<void> {
    this.initialization ??= this.storage.list().then(({ items, unreadable }) => {
      for (const id of unreadable) {
        this.blocked.add(id);
        this.report(id, "无法读取已保存草稿 / Saved draft could not be read");
      }
      for (const record of items) {
        this.revisions.set(record.id, record.revision);
        this.saved.set(record.id, JSON.stringify(record.value));
        try { this.restore(record); this.dirty.add(record.id); }
        catch {
          this.blocked.add(record.id);
          this.report(record.id, "草稿记录格式无效；原记录未覆盖。 / Invalid draft record. The saved copy is retained.");
        }
      }
      this.ready = true;
      if (this.dirty.size) this.schedule();
    }).catch(error => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  changed(id: string): void {
    this.dirty.add(id);
    if (this.ready) this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flushAll().catch(() => {}); }, this.delayMs);
  }

  async flushAll(): Promise<void> {
    await this.start();
    clearTimeout(this.timer);
    const ids = new Set([...this.dirty, ...this.writes.keys()]);
    const results = await Promise.allSettled([...ids].map(id => this.flush(id)));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  async flush(id: string): Promise<void> {
    await this.start();
    const previous = this.writes.get(id) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      if (this.blocked.has(id)) throw new Error("草稿在另一窗口更新或无法读取，请先处理草稿冲突。 / Resolve the draft conflict before saving.");
      while (this.dirty.has(id)) {
        this.dirty.delete(id);
        const value = this.read(id);
        const fingerprint = JSON.stringify(value);
        if (fingerprint === (this.saved.get(id) ?? "null")) { this.report(id); continue; }
        const result = await this.storage.write(id, this.revisions.get(id) ?? 0, value);
        if (!result.saved) {
          this.blocked.add(id);
          throw new Error("另一窗口已更新草稿；本窗口内容已保留。 / Another window updated this draft. Local input is retained.");
        }
        this.revisions.set(id, result.revision);
        this.saved.set(id, fingerprint);
        this.report(id);
        if (JSON.stringify(this.read(id)) !== fingerprint) this.dirty.add(id);
      }
    }).catch(error => {
      this.dirty.add(id);
      this.report(id, error instanceof Error ? error.message : String(error));
      throw error;
    });
    this.writes.set(id, write);
    try { await write; }
    finally { if (this.writes.get(id) === write) this.writes.delete(id); }
  }

  /** User chooses which window's input to keep. The other input remains on
   * screen in that window; no automatic last-writer-wins replacement. */
  async resolve(id: string, keepLocal: boolean): Promise<void> {
    const { items, unreadable } = await this.storage.list();
    if (unreadable.includes(id)) throw new Error("无法解密草稿；原记录未覆盖。 / The unreadable draft has not been overwritten.");
    const record = items.find(item => item.id === id) ?? { id, revision: 0, value: null, acceptedMessageIds: [] };
    this.revisions.set(id, record.revision);
    this.saved.set(id, JSON.stringify(record.value));
    this.blocked.delete(id);
    if (!keepLocal) this.restore(record);
    this.changed(id);
    await this.flush(id);
    this.report(id);
  }
}
