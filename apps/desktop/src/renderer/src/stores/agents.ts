import { create } from "zustand";
import type { AgentInstance, ProviderModelCatalog } from "@agenthub/domain";
import { requestCore } from "../lib/bridge";
import { toDomainAgent, toUiAgent } from "../lib/core-mappers";
import { providerMetas } from "../lib/provider-catalog";
import { newId } from "../lib/utils";
import type { AgentInstanceConfig, ProviderInstallation } from "../lib/types";

export type AgentInstanceDraft = Omit<AgentInstanceConfig, "id" | "status" | "createdAt" | "updatedAt">;

interface DetectionResult {
  providerId: string;
  installed: boolean;
  compatible?: boolean;
  executable: string;
  version?: string;
  error?: string;
}

interface AgentsState {
  installations: ProviderInstallation[];
  instances: AgentInstanceConfig[];
  detecting: Record<string, boolean>;
  modelCatalogs: Record<string, ProviderModelCatalog | undefined>;
  loadingModels: Record<string, boolean>;
  hydrate: () => Promise<void>;
  redetect: (providerId: string) => Promise<void>;
  loadModels: (agentInstanceId: string) => Promise<ProviderModelCatalog>;
  createInstance: (draft: AgentInstanceDraft) => Promise<AgentInstanceConfig>;
  updateInstance: (id: string, draft: AgentInstanceDraft) => Promise<void>;
  setInstanceEnabled: (id: string, enabled: boolean) => Promise<void>;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  installations: [],
  instances: [],
  detecting: {},
  modelCatalogs: {},
  loadingModels: {},

  hydrate: async () => {
    const instances = await requestCore<AgentInstance[]>("agent.list");
    const hydrated = await Promise.all(instances.map(async (instance) => {
      const status = await requestCore<{ stored: boolean }>("credential.status", { agentInstanceId: instance.id });
      return { ...toUiAgent(instance), credentialStored: status.stored };
    }));
    set({ instances: hydrated });
    await Promise.all(providerMetas().map((provider) => get().redetect(provider.id)));
  },

  redetect: async (providerId) => {
    set((state) => ({ detecting: { ...state.detecting, [providerId]: true } }));
    const configured = get().instances.find((instance) => instance.providerId === providerId);
    try {
      const result = await requestCore<DetectionResult>("provider.detect", {
        providerId: providerId === "custom-cli" ? "custom" : providerId,
        executable: configured?.executable
      });
      const installation = toInstallation(providerId, result);
      set((state) => ({
        detecting: { ...state.detecting, [providerId]: false },
        installations: upsertInstallation(state.installations, installation)
      }));
    } catch (error) {
      const installation: ProviderInstallation = {
        providerId,
        status: "error",
        executable: configured?.executable,
        message: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString()
      };
      set((state) => ({
        detecting: { ...state.detecting, [providerId]: false },
        installations: upsertInstallation(state.installations, installation)
      }));
    }
  },

  loadModels: async (agentInstanceId) => {
    const instance = get().instances.find((item) => item.id === agentInstanceId);
    if (!instance) throw new Error(`Agent instance ${agentInstanceId} is missing`);
    set((state) => ({ loadingModels: { ...state.loadingModels, [agentInstanceId]: true } }));
    try {
      const catalog = await requestCore<ProviderModelCatalog>("provider.models", {
        providerId: instance.providerId === "custom-cli" ? "custom" : instance.providerId,
        agentInstanceId,
        executable: instance.executable.trim() || undefined
      });
      set((state) => ({
        loadingModels: { ...state.loadingModels, [agentInstanceId]: false },
        modelCatalogs: { ...state.modelCatalogs, [agentInstanceId]: catalog }
      }));
      return catalog;
    } catch (error) {
      const catalog: ProviderModelCatalog = {
        providerId: instance.providerId,
        models: [],
        source: "unavailable",
        fetchedAt: new Date().toISOString(),
        warning: error instanceof Error ? error.message : String(error)
      };
      set((state) => ({
        loadingModels: { ...state.loadingModels, [agentInstanceId]: false },
        modelCatalogs: { ...state.modelCatalogs, [agentInstanceId]: catalog }
      }));
      return catalog;
    }
  },

  createInstance: async (draft) => {
    const now = new Date().toISOString();
    const instance: AgentInstanceConfig = {
      ...draft,
      id: newId("agent"),
      status: draft.enabled ? "available" : "disabled",
      createdAt: now,
      updatedAt: now
    };
    const saved = toUiAgent(await requestCore<AgentInstance>("agent.upsert", toDomainAgent(instance)));
    if (draft.apiKey) await requestCore<{ stored: true }>("credential.set", { agentInstanceId: saved.id, apiKey: draft.apiKey });
    const withCredential = { ...saved, credentialStored: !!draft.apiKey, apiKey: undefined };
    set((state) => ({ instances: [withCredential, ...state.instances] }));
    return withCredential;
  },

  updateInstance: async (id, draft) => {
    const current = get().instances.find((instance) => instance.id === id);
    if (!current) throw new Error(`Agent instance ${id} is missing`);
    const next: AgentInstanceConfig = {
      ...current,
      ...draft,
      status: draft.enabled ? (current.status === "disabled" ? "available" : current.status) : "disabled",
      updatedAt: new Date().toISOString()
    };
    const saved = toUiAgent(await requestCore<AgentInstance>("agent.upsert", toDomainAgent(next)));
    if (draft.apiKey) await requestCore<{ stored: true }>("credential.set", { agentInstanceId: saved.id, apiKey: draft.apiKey });
    const withCredential = { ...saved, credentialStored: draft.apiKey ? true : current.credentialStored, apiKey: undefined };
    set((state) => ({ instances: state.instances.map((instance) => instance.id === id ? withCredential : instance) }));
  },

  setInstanceEnabled: async (id, enabled) => {
    const current = get().instances.find((instance) => instance.id === id);
    if (!current) return;
    const { id: _id, status: _status, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = current;
    await get().updateInstance(id, {
      ...draft,
      enabled
    });
  }
}));

function toInstallation(uiProviderId: string, result: DetectionResult): ProviderInstallation {
  return {
    providerId: uiProviderId,
    status: result.installed ? (result.compatible === false ? "outdated" : "ready") : (result.error?.includes("尚未完成") ? "error" : "missing"),
    executable: result.executable || undefined,
    version: result.version,
    message: result.error,
    checkedAt: new Date().toISOString()
  };
}

function upsertInstallation(list: ProviderInstallation[], installation: ProviderInstallation): ProviderInstallation[] {
  const exists = list.some((item) => item.providerId === installation.providerId);
  return exists ? list.map((item) => item.providerId === installation.providerId ? installation : item) : [...list, installation];
}
