import type { ProviderModelCatalog } from "@agenthub/domain";

/** Small, process-local success cache. Never persists credentials or failures. */
export class ModelCatalogCache {
  private readonly ready = new Map<string, { expiresAt: number; catalog: ProviderModelCatalog }>();
  private readonly pending = new Map<string, Promise<ProviderModelCatalog>>();
  private generation = 0;
  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 30_000
  ) {}

  clear(): void { this.generation++; this.ready.clear(); this.pending.clear(); }

  async get(key: string, load: () => Promise<ProviderModelCatalog>, forceRefresh = false): Promise<ProviderModelCatalog> {
    const cached = this.ready.get(key);
    if (!forceRefresh && cached && cached.expiresAt > this.now()) return structuredClone(cached.catalog);
    if (cached) this.ready.delete(key);
    let pending = this.pending.get(key);
    if (!pending) {
      const generation = this.generation;
      let timer: ReturnType<typeof setTimeout> | undefined;
      pending = Promise.race([
        Promise.resolve().then(load),
        new Promise<ProviderModelCatalog>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Model catalog discovery timed out")), this.timeoutMs);
        })
      ]).then((catalog) => {
        if (generation === this.generation && catalog.source !== "unavailable" && !catalog.warning && catalog.models.length) {
          for (const [existingKey, entry] of this.ready) if (entry.expiresAt <= this.now()) this.ready.delete(existingKey);
          if (this.ready.size >= 128) this.ready.delete(this.ready.keys().next().value!);
          this.ready.set(key, { expiresAt: this.now() + this.ttlMs, catalog: structuredClone(catalog) });
        }
        return catalog;
      }).finally(() => {
        if (timer) clearTimeout(timer);
        if (this.pending.get(key) === pending) this.pending.delete(key);
      });
      this.pending.set(key, pending);
    }
    return structuredClone(await pending);
  }
}
