export interface MarkdownParseResult {
  id: number;
  fragments?: string[];
  error?: string;
}

export type MarkdownWorkerPort = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror" | "onmessageerror">;

type Listener = { result: (source: string, fragments: string[]) => void; error: () => void };
type Request = { owner: object; source: string; id: number };

/** One parser worker for the visible timeline, one in-flight snapshot, and
 * only the latest pending snapshot per mounted message. Map insertion order
 * prevents a busy stream from starving other visible messages. */
export class MarkdownWorkerQueue {
  private readonly listeners = new Map<object, Listener>();
  private readonly pending = new Map<object, Request>();
  private active?: Request;
  private nextId = 1;
  private closed = false;

  constructor(private worker: MarkdownWorkerPort, private readonly onEmpty: () => void, private readonly replaceWorker?: () => MarkdownWorkerPort) {
    this.listen();
  }

  private listen(): void {
    const worker = this.worker;
    worker.onmessage = ({ data }: MessageEvent<MarkdownParseResult>) => {
      const request = this.active;
      if (!request || data.id !== request.id) return;
      this.active = undefined;
      const listener = this.listeners.get(request.owner);
      if (data.error || !data.fragments) listener?.error();
      else listener?.result(request.source, data.fragments);
      this.drain();
    };
    const failed = (event: Event): void => {
      // Parsing already has a synchronous fallback. Prevent a handled worker
      // failure from bubbling to the window's fatal renderer overlay.
      event.preventDefault?.();
      this.fail();
    };
    worker.onerror = failed;
    worker.onmessageerror = failed;
  }

  subscribe(result: Listener["result"], error: Listener["error"]): { update: (source: string) => void; dispose: () => void } {
    const owner = {};
    this.listeners.set(owner, { result, error });
    return {
      update: (source) => {
        if (this.closed || !this.listeners.has(owner)) return;
        if (this.active?.owner === owner && this.active.source === source) {
          this.pending.delete(owner);
          return;
        }
        this.pending.set(owner, { owner, source, id: this.nextId++ });
        this.drain();
      },
      dispose: () => {
        this.listeners.delete(owner);
        this.pending.delete(owner);
        if (this.listeners.size === 0) this.close();
        else if (this.active?.owner === owner && this.replaceWorker) {
          // Do not leave a visible message behind a huge, now-unmounted parse.
          // Restarting only cancels that obsolete job, retaining other owners'
          // latest snapshots and their insertion order.
          this.detachWorker();
          this.active = undefined;
          try { this.worker = this.replaceWorker(); this.listen(); this.drain(); }
          catch { this.fail(); }
        }
      }
    };
  }

  private drain(): void {
    if (this.closed || this.active) return;
    const next = this.pending.values().next().value as Request | undefined;
    if (!next) return;
    this.pending.delete(next.owner);
    this.active = next;
    try { this.worker.postMessage({ id: next.id, source: next.source }); }
    catch { this.fail(); }
  }

  private fail(): void {
    const listeners = [...this.listeners.values()];
    this.close();
    for (const listener of listeners) listener.error();
  }

  private detachWorker(): void {
    this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
    this.worker.terminate();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachWorker();
    this.pending.clear();
    this.listeners.clear();
    this.active = undefined;
    this.onEmpty();
  }
}
