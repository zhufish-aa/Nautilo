import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { requestCore } from "../lib/bridge";

export type HarnessModeCatalog = {
  modes: Array<{ id: string; name?: string; broken?: string; order?: number }>;
  defaultMode?: string;
};

type ModeSource = { id: string; providerId: string; executable: string };

export function harnessModeKey(source: ModeSource): string {
  return JSON.stringify([source.id, source.providerId, source.executable]);
}

interface HarnessModesState {
  catalogs: Record<string, HarnessModeCatalog | undefined>;
  loading: Record<string, boolean | undefined>;
  errors: Record<string, boolean | undefined>;
  loadModes: (source: ModeSource, refresh?: boolean) => Promise<void>;
}

const pending = new Map<string, Promise<void>>();

export const useHarnessModesStore = create<HarnessModesState>()(
  persist(
    (set, get) => ({
      catalogs: {},
      loading: {},
      errors: {},
      loadModes: (source, refresh = false) => {
        const key = harnessModeKey(source);
        const state = get();
        if (!refresh && (state.catalogs[key] || state.errors[key])) return Promise.resolve();
        const existing = pending.get(key);
        if (existing) return existing;

        // Successful native discovery is kept until the user refreshes it.
        // Only persist the result, never pending requests or loading/error UI.
        const operation = Promise.resolve()
          .then(() => requestCore<HarnessModeCatalog>("provider.modes", { agentInstanceId: source.id }))
          .then(catalog => {
            set(state => ({ catalogs: { ...state.catalogs, [key]: catalog } }));
          })
          .catch(() => {
            set(state => ({ errors: { ...state.errors, [key]: true } }));
          })
          .finally(() => {
            pending.delete(key);
            set(state => ({ loading: { ...state.loading, [key]: false } }));
          });
        pending.set(key, operation);
        set(state => ({
          loading: { ...state.loading, [key]: true },
          errors: { ...state.errors, [key]: false }
        }));
        return operation;
      }
    }),
    {
      name: "agenthub-harness-modes-v1",
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({ catalogs: state.catalogs })
    }
  )
);
