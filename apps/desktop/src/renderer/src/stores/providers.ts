import { create } from "zustand";
import type { ProviderDescriptor } from "@agenthub/provider-sdk";
import { getBridge, requestCore } from "../lib/bridge";

/**
 * Daemon-served provider catalog: built-in adapters plus any loaded provider
 * plugins. Hydrated once at startup (before the agents store, which redetects
 * every catalog entry) and refreshed after plugin install/uninstall.
 */
interface ProvidersState {
  catalog: ProviderDescriptor[];
  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const useProvidersStore = create<ProvidersState>((set) => ({
  catalog: [],

  hydrate: async () => {
    if (!getBridge()) return;
    try {
      const catalog = await requestCore<ProviderDescriptor[]>("provider.catalog");
      set({ catalog });
    } catch {
      // A daemon without provider.catalog leaves the catalog empty.
    }
  },

  refresh: async () => {
    if (!getBridge()) return;
    const catalog = await requestCore<ProviderDescriptor[]>("provider.catalog");
    set({ catalog });
  }
}));
