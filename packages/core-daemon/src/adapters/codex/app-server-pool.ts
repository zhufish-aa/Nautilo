import type { ProcessHandle } from "../../process-runtime.js";
import type { JsonRpcProcessClient } from "../json-rpc-process.js";

export interface CodexPoolSlot {
  process: ProcessHandle;
  rpc: JsonRpcProcessClient;
  initialized: boolean;
  /** Belongs to this process generation and is discarded with the slot. */
  loadedThreadId?: string;
  initialize?: () => Promise<void>;
}
interface Slot extends CodexPoolSlot {
  session: string;
  generation: number;
  busy: boolean;
  used: number;
  timer?: NodeJS.Timeout;
  closing?: Promise<void>;
}
interface Waiter {
  order: number;
  bootstrap: AbortController;
  session: string;
  generation: number;
  signal: AbortSignal;
  factory: () => CodexPoolSlot;
  bootstrapKey: string;
  resolve: (lease: CodexPoolLease) => void;
  reject: (error: Error) => void;
  abort: () => void;
}
export interface CodexPoolLease {
  slot: CodexPoolSlot;
  release(healthy: boolean): Promise<void>;
}
export class CodexAppServerOwner {
  readonly pools = new Map<string, CodexAppServerPool>();
  readonly legacyProcesses = new Set<ProcessHandle>();
  stopped = false;
  shutdown?: Promise<void>;
}
const defaultOwner = new CodexAppServerOwner();
const owners = new Set<CodexAppServerOwner>();
let stopped = false;
let shutdown: Promise<void> | undefined;
export function assertCodexAppServerRunning(owner: CodexAppServerOwner = defaultOwner): void {
  if (stopped || owner.stopped) throw new Error("Codex app-server transport is shut down");
}
export function trackLegacyCodexProcess(process: ProcessHandle, owner: CodexAppServerOwner = defaultOwner): void {
  assertCodexAppServerRunning(owner);
  owners.add(owner);
  owner.legacyProcesses.add(process);
  process.child.once("close", () => {
    owner.legacyProcesses.delete(process);
    if (!owner.pools.size && !owner.legacyProcesses.size) owners.delete(owner);
  });
}
/** Retire one instance without resetting its owner's shutdown gate. */
export async function closeCodexAppServerPool(instanceId: string, owner: CodexAppServerOwner = defaultOwner): Promise<void> {
  const pool = owner.pools.get(instanceId);
  if (!pool) return;
  owner.pools.delete(instanceId);
  await pool.shutdown();
}
// Only a cold Codex HOME needs serialized initialization. Store opaque keys,
// never HOME paths or credentials. Once warm, independent launches are parallel.
interface BootstrapWaiter {
  signal: AbortSignal;
  resolve: (release: (success: boolean) => void) => void;
  reject: (error: Error) => void;
  abort: () => void;
}
interface BootstrapHome {
  warm: boolean;
  busy: boolean;
  active: number;
  waiters: BootstrapWaiter[];
  timer?: NodeJS.Timeout;
}
const bootstrapHomes = new Map<string, BootstrapHome>();
function expireWarmHome(key: string, home: BootstrapHome): void {
  if (home.timer) clearTimeout(home.timer);
  if (home.busy || home.active || home.waiters.length) return;
  home.timer = setTimeout(() => {
    if (!home.busy && !home.active && !home.waiters.length && bootstrapHomes.get(key) === home) bootstrapHomes.delete(key);
  }, 60_000);
  home.timer.unref();
}
function warmBootstrapLease(key: string, home: BootstrapHome): (success: boolean) => void {
  if (home.timer) clearTimeout(home.timer);
  home.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    home.active--;
    expireWarmHome(key, home);
  };
}
function acquireBootstrap(key: string, signal: AbortSignal): Promise<(success: boolean) => void> {
  if (signal.aborted) return Promise.reject(new Error("Codex bootstrap cancelled"));
  let home = bootstrapHomes.get(key);
  if (!home) { home = { warm: false, busy: false, active: 0, waiters: [] }; bootstrapHomes.set(key, home); }
  if (home.warm) return Promise.resolve(warmBootstrapLease(key, home));
  const state = home;
  const release = (success: boolean): void => {
    if (success) {
      state.warm = true;
      state.busy = false;
      for (const waiter of state.waiters.splice(0)) {
        waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.resolve(warmBootstrapLease(key, state));
      }
      expireWarmHome(key, state);
    } else {
      const next = state.waiters.shift();
      if (next) { next.signal.removeEventListener("abort", next.abort); next.resolve(release); }
      else { state.busy = false; bootstrapHomes.delete(key); }
    }
  };
  if (!state.busy) { state.busy = true; return Promise.resolve(release); }
  return new Promise((resolve, reject) => {
    const waiter: BootstrapWaiter = { signal, resolve, reject, abort: () => {
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      reject(new Error("Codex bootstrap cancelled"));
    } };
    state.waiters.push(waiter);
    signal.addEventListener("abort", waiter.abort, { once: true });
  });
}
export function codexPoolSize(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}
export function codexAppServerPool(instanceId: string, owner: CodexAppServerOwner = defaultOwner): CodexAppServerPool {
  assertCodexAppServerRunning(owner);
  owners.add(owner);
  let pool = owner.pools.get(instanceId);
  if (!pool) { pool = new CodexAppServerPool(owner); owner.pools.set(instanceId, pool); }
  return pool;
}
export function shutdownCodexAppServerOwner(owner: CodexAppServerOwner): Promise<void> {
  if (owner.shutdown) return owner.shutdown;
  owner.stopped = true;
  const current = [...owner.pools.values()];
  owner.pools.clear();
  owner.shutdown = Promise.all([
    ...current.map((pool) => pool.shutdown()),
    ...[...owner.legacyProcesses].map(async (process) => {
      const kill = setTimeout(() => process.child.kill("SIGKILL"), 500);
      kill.unref();
      try { await process.cancel(); } finally { clearTimeout(kill); owner.legacyProcesses.delete(process); }
    })
  ]).then(() => { owners.delete(owner); });
  return owner.shutdown;
}
/** Process termination only. Ordinary daemon shutdown closes just its adapter owner. */
export function shutdownCodexAppServerPools(): Promise<void> {
  if (shutdown) return shutdown;
  stopped = true;
  shutdown = Promise.all([...new Set([defaultOwner, ...owners])].map(shutdownCodexAppServerOwner)).then(() => undefined);
  return shutdown;
}

/** One exclusive session per subprocess. Closing processes continue to occupy capacity. */
export class CodexAppServerPool {
  constructor(private readonly owner: CodexAppServerOwner = defaultOwner) {}
  private slots: Slot[] = [];
  private queue: Waiter[] = [];
  private starting = new Set<Waiter>();
  private configurations = new Map<string, { fingerprint: string; generation: number }>();
  private capacity = Number.POSITIVE_INFINITY;
  private nextOrder = 0;
  private draining = false;
  private closed = false;
  private readonly shutdownSignal = new AbortController();

  acquire(session: string, fingerprint: string, capacity: number, signal: AbortSignal, factory: () => CodexPoolSlot, bootstrapKey: string): Promise<CodexPoolLease> {
    if (this.closed || signal.aborted) return Promise.reject(new Error("Codex run cancelled before admission"));
    this.capacity = codexPoolSize(capacity);
    const previous = this.configurations.get(session);
    const generation = previous?.fingerprint === fingerprint ? previous.generation : (previous?.generation ?? 0) + 1;
    if (previous?.fingerprint !== fingerprint) {
      this.configurations.set(session, { fingerprint, generation });
      for (const waiter of this.queue.filter((item) => item.session === session)) {
        this.queue.splice(this.queue.indexOf(waiter), 1);
        waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.reject(new Error("Codex configuration changed while waiting"));
      }
      for (const waiter of this.starting) if (waiter.session === session) waiter.bootstrap.abort();
      for (const slot of this.slots) if (slot.session === session && !slot.busy) void this.close(slot);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { order: this.nextOrder++, bootstrap: new AbortController(), session, generation, signal, factory, bootstrapKey, resolve, reject, abort: () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) { this.queue.splice(index, 1); reject(new Error("Codex run cancelled before admission")); void this.drain(); }
      } };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
      void this.drain();
    });
  }
  private async close(slot: Slot): Promise<void> {
    if (slot.closing) return slot.closing;
    if (slot.timer) clearTimeout(slot.timer);
    slot.closing = (async () => {
      // ProcessRuntime's SIGTERM is cooperative on Unix. Escalate for a wedged CLI.
      const kill = setTimeout(() => slot.process.child.kill("SIGKILL"), 500);
      kill.unref();
      try { await slot.process.cancel(); } finally {
        clearTimeout(kill);
        this.slots = this.slots.filter((item) => item !== slot);
        void this.drain();
      }
    })();
    return slot.closing;
  }
  private lease(waiter: Waiter, slot: Slot): void {
    slot.busy = true;
    if (slot.timer) clearTimeout(slot.timer);
    let released = false;
    waiter.resolve({ slot, release: async (healthy) => {
      if (released) return;
      released = true;
      if (!healthy || slot.generation !== this.configurations.get(slot.session)?.generation || this.closed) await this.close(slot);
      slot.busy = false;
      slot.used = Date.now();
      if (!slot.closing) {
        slot.timer = setTimeout(() => { void this.close(slot); }, 60_000);
        slot.timer.unref();
      }
      void this.drain();
    } });
  }
  private async launch(waiter: Waiter): Promise<void> {
    let unlock: ((success: boolean) => void) | undefined;
    let initialized = false;
    try {
      unlock = await acquireBootstrap(waiter.bootstrapKey, AbortSignal.any([waiter.signal, waiter.bootstrap.signal, this.shutdownSignal.signal]));
      if (waiter.signal.aborted || this.closed) throw new Error("Codex bootstrap cancelled");
      if (waiter.generation !== this.configurations.get(waiter.session)?.generation) throw new Error("Codex configuration changed while waiting for bootstrap");
      // Recheck a user limit changed while waiting for a cold HOME.
      if (this.slots.length >= this.capacity) {
        this.queue.push(waiter);
        this.queue.sort((a, b) => a.order - b.order);
        waiter.signal.addEventListener("abort", waiter.abort, { once: true });
        return;
      }
      const slot: Slot = { ...waiter.factory(), session: waiter.session, generation: waiter.generation, busy: true, used: Date.now() };
      this.slots.push(slot);
      this.starting.delete(waiter);
      slot.process.child.once("close", () => { void this.close(slot); });
      const abortBootstrap = (): void => { void this.close(slot); };
      waiter.signal.addEventListener("abort", abortBootstrap, { once: true });
      try {
        await slot.initialize?.();
        slot.initialized = true;
        initialized = true;
        if (waiter.signal.aborted || this.closed) throw new Error("Codex run cancelled during initialization");
        this.lease(waiter, slot);
      } catch (error) { await this.close(slot); throw error; }
      finally { waiter.signal.removeEventListener("abort", abortBootstrap); }
    } catch (error) { waiter.reject(waiter.bootstrap.signal.aborted ? new Error("Codex configuration changed while waiting for bootstrap") : error instanceof Error ? error : new Error(String(error))); }
    finally {
      unlock?.(initialized);
      this.starting.delete(waiter);
      void this.drain();
    }
  }
  private async drain(): Promise<void> {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        // FIFO among admissible sessions, including sessions still initializing.
        const index = this.queue.findIndex((item) =>
          !this.slots.some((slot) => slot.session === item.session && slot.busy) &&
          ![...this.starting].some((pending) => pending.session === item.session));
        if (index < 0) break;
        const waiter = this.queue[index]!;
        if (waiter.signal.aborted) { waiter.abort(); continue; }
        const slot = this.slots.find((item) => item.session === waiter.session && item.generation === waiter.generation && !item.closing);
        if (!slot && this.slots.length + this.starting.size >= this.capacity) {
          const idle = this.slots.filter((item) => !item.busy).sort((a, b) => a.used - b.used)[0];
          if (!idle) break;
          await this.close(idle);
          continue;
        }
        this.queue.splice(index, 1);
        waiter.signal.removeEventListener("abort", waiter.abort);
        if (slot) this.lease(waiter, slot);
        else {
          this.starting.add(waiter);
          // Once HOME is warm, independent fresh launches initialize in parallel.
          void this.launch(waiter);
        }
      }
    } finally {
      this.draining = false;
      for (const session of this.configurations.keys()) {
        if (!this.slots.some((slot) => slot.session === session) && !this.queue.some((waiter) => waiter.session === session) && ![...this.starting].some((waiter) => waiter.session === session)) this.configurations.delete(session);
      }
      if (!this.slots.length && !this.queue.length && !this.starting.size) {
        for (const [id, pool] of this.owner.pools) if (pool === this) this.owner.pools.delete(id);
        if (!this.owner.pools.size && !this.owner.legacyProcesses.size) owners.delete(this.owner);
      }
    }
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    this.shutdownSignal.abort();
    for (const waiter of this.queue.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(new Error("Codex pool shut down"));
    }
    await Promise.all(this.slots.map((slot) => this.close(slot)));
  }
}
