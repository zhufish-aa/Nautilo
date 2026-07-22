/**
 * Serializes provider turns per logical session while allowing different
 * sessions (for example a main session and its delegated child) to run in
 * parallel.
 */
export class SessionRunQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue<THandle extends { completion: Promise<unknown> }>(
    sessionId: string,
    start: () => Promise<THandle>
  ): Promise<THandle> {
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

  busy(sessionId: string): boolean {
    return this.tails.has(sessionId);
  }
}
