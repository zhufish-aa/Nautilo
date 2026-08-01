/**
 * Serializes provider turns per logical session while allowing different
 * sessions (for example a main session and its delegated child) to run in
 * parallel.
 *
 * Entries can carry an optional key. A keyed entry that is still waiting for
 * the previous turn to settle can be withdrawn with cancelPending — the start
 * closure is then skipped and the returned promise rejects instead of
 * launching a new provider turn.
 */
export class SessionRunQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pendingKeys = new Map<string, Set<string>>();

  enqueue<THandle extends { completion: Promise<unknown> }>(
    sessionId: string,
    start: () => Promise<THandle>,
    key?: string
  ): Promise<THandle> {
    if (key) {
      const pending = this.pendingKeys.get(sessionId) ?? new Set<string>();
      pending.add(key);
      this.pendingKeys.set(sessionId, pending);
    }
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let resolveStarted!: (handle: THandle) => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<THandle>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });

    const tail = previous
      .catch(() => undefined)
      .then(async () => {
        if (key && !this.cancelPending(sessionId, key)) {
          rejectStarted(new Error("Queued turn was withdrawn before it started"));
          return;
        }
        try {
          const handle = await start();
          resolveStarted(handle);
          await handle.completion.catch(() => undefined);
        } catch (error) {
          rejectStarted(error);
        }
      });

    this.tails.set(sessionId, tail);
    void tail.then(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    });
    return started;
  }

  /**
   * Withdraws a keyed entry that has not started yet. Returns false when the
   * key is unknown or its turn already began.
   */
  cancelPending(sessionId: string, key: string): boolean {
    const pending = this.pendingKeys.get(sessionId);
    if (!pending?.has(key)) return false;
    pending.delete(key);
    if (!pending.size) this.pendingKeys.delete(sessionId);
    return true;
  }

  busy(sessionId: string): boolean {
    return this.tails.has(sessionId);
  }
}
