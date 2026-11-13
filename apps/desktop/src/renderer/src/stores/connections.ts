import { create } from "zustand";
import type { ProviderModelCatalog, RuntimeConnection } from "@agenthub/domain";
import { requestCore } from "../lib/bridge";
import { withDefaultReasoning } from "../lib/model-reasoning";
import { connectionModelCatalog, hasConfiguredConnectionModels } from "../lib/connection-models";

export type ConnectionDraft = Omit<RuntimeConnection, "revision" | "createdAt" | "updatedAt" | "hasCredential" | "accountGateway">;
interface ConnectionsState {
  connections: RuntimeConnection[];
  loading: boolean;
  modelCatalogs: Record<string, ProviderModelCatalog | undefined>;
  loadingModels: Record<string, boolean>;
  loadModels: (connectionId: string, revision?: number, force?: boolean) => Promise<ProviderModelCatalog>;
  error?: string;
  hydrate: () => Promise<void>;
  setAccountRoute: (connectionId: string, enabled: boolean) => Promise<RuntimeConnection>;
  save: (connection: ConnectionDraft, expectedRevision?: number, apiKey?: string, clearApiKey?: boolean) => Promise<RuntimeConnection>;
  remove: (connectionId: string) => Promise<void>;
  get: (connectionId: string, revision?: number) => Promise<RuntimeConnection>;
  models: (connectionId: string, revision?: number, agentInstanceId?: string) => Promise<ProviderModelCatalog>;
}
export const connectionModelKey = (id: string, revision: number): string => `${id}:${revision}`;
const modelRequests = new Map<string, Promise<ProviderModelCatalog>>();
const MODEL_CACHE_MS = 5 * 60_000;
let loadGeneration = 0;
export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
  connections: [], loading: false, modelCatalogs: {}, loadingModels: {},
  setAccountRoute: async (connectionId, enabled) => {
    const saved = await requestCore<RuntimeConnection>("connection.gateway", { connectionId, enabled });
    loadGeneration++;
    set(state => ({ loading: false, connections: state.connections.map(item => item.id === saved.id ? saved : item) }));
    return saved;
  },
  hydrate: async () => {
    const generation = ++loadGeneration;
    set({ loading: true, error: undefined });
    try { const connections = await requestCore<RuntimeConnection[]>("connection.list", {}); if (generation === loadGeneration) set({ connections, loading: false }); }
    catch (error) { if (generation === loadGeneration) set({ loading: false, error: error instanceof Error ? error.message : String(error) }); }
  },
  save: async (connection, expectedRevision, apiKey, clearApiKey) => {
    const saved = await requestCore<RuntimeConnection>("connection.upsert", { connection, expectedRevision, apiKey: apiKey?.trim() || undefined, clearApiKey });
    loadGeneration++;
    set((state) => ({
      loading: false,
      connections: [...state.connections.filter((item) => item.id !== saved.id), saved],
      ...(hasConfiguredConnectionModels(saved) ? { modelCatalogs: { ...state.modelCatalogs, [connectionModelKey(saved.id, saved.revision)]: connectionModelCatalog(saved) } } : {}),
    }));
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
  loadModels: async (connectionId, revision, force = false) => {
    const head = get().connections.find((connection) => connection.id === connectionId);
    const connection = head && (revision === undefined || revision === head.revision) ? head : await get().get(connectionId, revision);
    const version = connection.revision;
    const key = connectionModelKey(connectionId, version);
    const cached = get().modelCatalogs[key];
    if (!force && hasConfiguredConnectionModels(connection)) {
      const catalog = connectionModelCatalog(connection, cached);
      set(state => ({ modelCatalogs: { ...state.modelCatalogs, [key]: catalog } }));
      return catalog;
    }
    if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < MODEL_CACHE_MS) return connectionModelCatalog(connection, cached);
    return connectionModelCatalog(connection, await get().models(connectionId, version));
  },
  models: async (connectionId, revision, agentInstanceId) => {
    const version = revision ?? get().connections.find((connection) => connection.id === connectionId)?.revision ?? (await get().get(connectionId)).revision;
    const key = connectionModelKey(connectionId, version);
    const existing = modelRequests.get(key);
    if (existing) return existing;
    set((state) => ({ loadingModels: { ...state.loadingModels, [key]: true } }));
    const request = requestCore<ProviderModelCatalog>("connection.models", { connectionId, revision: version, agentInstanceId }).catch((): ProviderModelCatalog => ({
      providerId: `connection:${connectionId}`, models: [], source: "unavailable", fetchedAt: new Date().toISOString(),
      warning: "暂时无法获取模型，请检查 Harness 安装和账号状态后重试。"
    })).then(async (catalog) => {
      const connection = get().connections.find((item) => item.id === connectionId && item.revision === version) ?? await get().get(connectionId, version);
      const configured = new Set((connection.models ?? []).map((model) => model.id));
      const result = { ...catalog, models: catalog.models.map((model) => configured.has(model.id) ? model : withDefaultReasoning(model)) };
      // Explicit discovery returns the full catalog to the settings editor.
      // Chat and team selectors cache only models enabled in this revision.
      set((state) => ({ modelCatalogs: { ...state.modelCatalogs, [key]: connectionModelCatalog(connection, result) } }));
      return result;
    }).finally(() => {
      modelRequests.delete(key);
      set((state) => ({ loadingModels: { ...state.loadingModels, [key]: false } }));
    });
    modelRequests.set(key, request);
    return request;
  },
}));
