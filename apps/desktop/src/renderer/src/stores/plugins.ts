import { create } from "zustand";
import type { ProviderRegistryEntry } from "@agenthub/provider-sdk";
import type { ProviderPluginInfo } from "@agenthub/schemas";
import { requestCore } from "../lib/bridge";
import { useProvidersStore } from "./providers";

/**
 * Provider plugin lifecycle + marketplace state. Every mutation ends with a
 * provider-catalog refresh so newly installed providers show up in the
 * detection page and instance editor without a restart.
 */
interface PluginsState {
  installed: ProviderPluginInfo[];
  registry: ProviderRegistryEntry[];
  registryError?: string;
  loadingRegistry: boolean;
  hydrate: () => Promise<void>;
  fetchRegistry: (registryUrl?: string) => Promise<void>;
  installLocal: (path: string) => Promise<ProviderPluginInfo>;
  installFromRegistry: (pluginId: string) => Promise<ProviderPluginInfo>;
  uninstall: (pluginId: string) => Promise<void>;
  setEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
}

export const usePluginsStore = create<PluginsState>((set, get) => {
  /** Reloads installed plugins and the provider catalog after a mutation. */
  const settle = async (): Promise<void> => {
    const installed = await requestCore<ProviderPluginInfo[]>("plugin.list");
    set({ installed });
    await useProvidersStore.getState().refresh().catch(() => undefined);
  };

  return {
    installed: [],
    registry: [],
    loadingRegistry: false,

    hydrate: async () => {
      const installed = await requestCore<ProviderPluginInfo[]>("plugin.list");
      set({ installed });
    },

    fetchRegistry: async (registryUrl) => {
      set({ loadingRegistry: true, registryError: undefined });
      try {
        const registry = await requestCore<ProviderRegistryEntry[]>("plugin.registry", { registryUrl });
        set({ registry, loadingRegistry: false });
      } catch (error) {
        set({ loadingRegistry: false, registryError: error instanceof Error ? error.message : String(error) });
      }
    },

    installLocal: async (path) => {
      const record = await requestCore<ProviderPluginInfo>("plugin.install", { source: { kind: "local", path } });
      await settle();
      return record;
    },

    installFromRegistry: async (pluginId) => {
      const record = await requestCore<ProviderPluginInfo>("plugin.install", { source: { kind: "registry", pluginId } });
      await settle();
      return record;
    },

    uninstall: async (pluginId) => {
      await requestCore<{ removed: true }>("plugin.uninstall", { pluginId });
      await settle();
    },

    setEnabled: async (pluginId, enabled) => {
      await requestCore<ProviderPluginInfo>("plugin.setEnabled", { pluginId, enabled });
      await settle();
    }
  };
});

/** Numeric-ish semver compare: a > b → 1, a < b → -1, equal → 0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}
