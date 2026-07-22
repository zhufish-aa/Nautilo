import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LocaleCode } from "../lib/utils";
import type { NavKey, ThemePreference } from "../lib/types";

/** Modules the user may hide from the sidebar; the rest stay pinned (F-003). */
export const TOGGLABLE_NAV_KEYS: NavKey[] = ["teams", "tasks", "sessions", "runs"];
export const PINNED_NAV_KEYS: NavKey[] = ["projects", "agents", "settings"];

interface SettingsState {
  theme: ThemePreference;
  locale: LocaleCode;
  reduceMotion: boolean;
  hiddenNav: NavKey[];
  setTheme: (theme: ThemePreference) => void;
  setLocale: (locale: LocaleCode) => void;
  setReduceMotion: (reduce: boolean) => void;
  setNavVisible: (key: NavKey, visible: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      locale: "zh-CN",
      reduceMotion: false,
      hiddenNav: [],
      setTheme: (theme) => set({ theme }),
      setLocale: (locale) => set({ locale }),
      setReduceMotion: (reduceMotion) => set({ reduceMotion }),
      setNavVisible: (key, visible) =>
        set((state) => ({
          hiddenNav: visible
            ? state.hiddenNav.filter((item) => item !== key)
            : state.hiddenNav.includes(key)
              ? state.hiddenNav
              : [...state.hiddenNav, key]
        }))
    }),
    {
      name: "agenthub.settings",
      version: 1
    }
  )
);
