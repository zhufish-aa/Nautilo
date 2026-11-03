import { create } from "zustand";
import type { ProviderModelCatalog, RuntimeConnection } from "@agenthub/domain";
import { requestCore } from "../lib/bridge";

export type ConnectionDraft = Omit<RuntimeConnection, "revision" | "createdAt" | "updatedAt" | "hasCredential">;
interface ConnectionsState {
  connections: RuntimeConnection[];
  loading: boolean;
  error?: string;
  hydrate: () => Promise<void>;
  save: (connection: ConnectionDraft, expectedRevision?: number, apiKey?: string, clearApiKey?: boolean) => Promise<RuntimeConnection>;
  remove: (connectionId: string) => Promise<void>;
  get: (connectionId: string, revision?: number) => Promise<RuntimeConnection>;
  models: (connectionId: string, revision?: number, agentInstanceId?: string) => Promise<ProviderModelCatalog>;
}
let loadGeneration = 0;
export const useConnectionsStore = create<ConnectionsState>((set) => ({
  connections: [], loading: false,
  hydrate: async () => {
    const generation = ++loadGeneration;
    set({ loading: true, error: undefined });
    try { const connections = await requestCore<RuntimeConnection[]>("connection.list", {}); if (generation === loadGeneration) set({ connections, loading: false }); }
    catch (error) { if (generation === loadGeneration) set({ loading: false, error: error instanceof Error ? error.message : String(error) }); }
  },
  save: async (connection, expectedRevision, apiKey, clearApiKey) => {
    const saved = await requestCore<RuntimeConnection>("connection.upsert", { connection, expectedRevision, apiKey: apiKey?.trim() || undefined, clearApiKey });
    loadGeneration++;
    set((state) => ({ loading: false, connections: [...state.connections.filter((item) => item.id !== saved.id), saved] }));
    return saved;
  },
  remove: async (connectionId) => {
    const result = await requestCore<{ removed: boolean }>("connection.remove", { connectionId });
    if (!result.removed) throw new Error("连接未移除 / Connection was not removed");
    loadGeneration++;
    set((state) => ({ loading: false, connections: state.connections.filter((item) => item.id !== connectionId) }));
  },
  get: async (connectionId, revision) => {
    const connection = await requestCore<RuntimeConnection>("connection.get", { connectionId, revision });
    if (revision === undefined) {
      loadGeneration++;
      set((state) => ({ loading: false, connections: [...state.connections.filter((item) => item.id !== connectionId), connection] }));
    }
    return connection;
  },
  models: (connectionId, revision, agentInstanceId) => requestCore<ProviderModelCatalog>("connection.models", { connectionId, revision, agentInstanceId }),
}));
