import { create } from "zustand";
import type { ProviderCapability } from "@agenthub/domain";
import type {
  CapabilityImportConflictPolicy,
  CapabilityImportOutcome,
  CapabilityImportPreview,
  CapabilityImportSource,
  CapabilityScanResult,
  DiscoveredMcpSource
} from "@agenthub/schemas";
import { requestCore } from "../lib/bridge";

interface ProviderToolsState {
  tools: ProviderCapability[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  save: (capability: ProviderCapability) => Promise<ProviderCapability>;
  toggle: (id: string, enabled: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  parseImport: (input: { source: CapabilityImportSource; text: string; fileName?: string }) => Promise<CapabilityImportPreview>;
  discoverMcp: (projectRoot?: string) => Promise<DiscoveredMcpSource[]>;
  scanSkills: (dir: string) => Promise<CapabilityScanResult>;
  importMany: (items: ProviderCapability[], onConflict: CapabilityImportConflictPolicy) => Promise<CapabilityImportOutcome[]>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Skills & MCP capabilities live in Core Daemon. The renderer never fabricates
 * entries: outside the desktop shell `load()` surfaces the bridge error instead.
 */
export const useProviderToolsStore = create<ProviderToolsState>((set, get) => ({
  tools: [],
  loading: false,
  loaded: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const tools = await requestCore<ProviderCapability[]>("capability.list");
      set({ tools, loading: false, loaded: true });
    } catch (error) {
      set({ loading: false, loaded: true, error: messageOf(error) });
    }
  },

  save: async (capability) => {
    const saved = await requestCore<ProviderCapability>("capability.upsert", capability);
    set((state) => {
      const exists = state.tools.some((tool) => tool.id === saved.id);
      return {
        tools: exists
          ? state.tools.map((tool) => (tool.id === saved.id ? saved : tool))
          : [saved, ...state.tools]
      };
    });
    return saved;
  },

  toggle: async (id, enabled) => {
    const current = get().tools.find((tool) => tool.id === id);
    if (!current) return;
    await get().save({ ...current, enabled, updatedAt: new Date().toISOString() });
  },

  remove: async (id) => {
    await requestCore<{ removed: true }>("capability.remove", { capabilityId: id });
    set((state) => ({ tools: state.tools.filter((tool) => tool.id !== id) }));
  },

  // Parsing and file scanning live in Core Daemon so the renderer stays free of
  // config-format rules and filesystem access.
  parseImport: async (input) => requestCore<CapabilityImportPreview>("capability.parseImport", input),

  discoverMcp: async (projectRoot) =>
    (await requestCore<{ sources: DiscoveredMcpSource[] }>("capability.discoverMcp", { projectRoot })).sources,

  scanSkills: async (dir) => requestCore<CapabilityScanResult>("capability.scanSkills", { dir }),

  importMany: async (items, onConflict) => {
    const { results } = await requestCore<{ results: CapabilityImportOutcome[] }>("capability.importMany", { items, onConflict });
    // Names and ids are resolved daemon-side, so reload rather than guess.
    await get().load();
    return results;
  }
}));
