import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LocaleCode } from "../lib/utils";
import type { NavKey, ThemePreference } from "../lib/types";
import type { PromptSnippet } from "../lib/snippets";
import { isValidTheme, type ThemeDefinition } from "../lib/themes";

/** Modules the user may hide from the sidebar; the rest stay pinned (F-003). */
export const TOGGLABLE_NAV_KEYS: NavKey[] = ["teams", "tasks", "sessions", "runs"];
export const PINNED_NAV_KEYS: NavKey[] = ["projects", "agents", "settings"];

interface SettingsState {
  theme: ThemePreference;
  locale: LocaleCode;
  reduceMotion: boolean;
  hiddenNav: NavKey[];
  /** "跑完了叫我": system notifications for finished turns and pending approvals. */
  notificationsEnabled: boolean;
  notificationSound: boolean;
  /** Composer "//" prompt snippets. */
  promptSnippets: PromptSnippet[];
  /** Session-list groups (by projectId) the user collapsed. */
  collapsedProjects: string[];
  /** Installed theme packs (theme market / user-made), overlaid on builtins. */
  customThemes: ThemeDefinition[];
  /** First-run onboarding tour finished or skipped. */
  onboardingCompleted: boolean;
  setTheme: (theme: ThemePreference) => void;
  setLocale: (locale: LocaleCode) => void;
  setReduceMotion: (reduce: boolean) => void;
  setNavVisible: (key: NavKey, visible: boolean) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setNotificationSound: (enabled: boolean) => void;
  upsertSnippet: (snippet: PromptSnippet) => void;
  removeSnippet: (id: string) => void;
  toggleProjectCollapsed: (projectId: string) => void;
  /** Install (or replace) a theme pack; rejects malformed definitions. */
  installTheme: (theme: ThemeDefinition) => boolean;
  uninstallTheme: (id: string) => void;
  setOnboardingCompleted: (completed: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      locale: "zh-CN",
      reduceMotion: false,
      hiddenNav: [],
      notificationsEnabled: true,
      notificationSound: true,
      collapsedProjects: [],
      customThemes: [],
      onboardingCompleted: false,
      promptSnippets: [
        { id: "seed-test-fix", title: "跑测试并修红", text: "运行本项目的测试，定位失败的用例并修复，直到全部通过。" },
        { id: "seed-review", title: "审查本次改动", text: "审查当前工作区的改动，指出潜在 bug、回归风险和可简化之处，按严重程度排序。" },
        { id: "seed-commit", title: "中文 commit", text: "提交当前改动，编写简洁的中文 commit message，并说明改动摘要。" }
      ],
      setTheme: (theme) => set({ theme }),
      setLocale: (locale) => set({ locale }),
      setReduceMotion: (reduceMotion) => set({ reduceMotion }),
      setNotificationsEnabled: (notificationsEnabled) => set({ notificationsEnabled }),
      setNotificationSound: (notificationSound) => set({ notificationSound }),
      upsertSnippet: (snippet) =>
        set((state) => ({
          promptSnippets: state.promptSnippets.some((item) => item.id === snippet.id)
            ? state.promptSnippets.map((item) => item.id === snippet.id ? snippet : item)
            : [...state.promptSnippets, snippet]
        })),
      removeSnippet: (id) =>
        set((state) => ({ promptSnippets: state.promptSnippets.filter((item) => item.id !== id) })),
      toggleProjectCollapsed: (projectId) =>
        set((state) => ({
          collapsedProjects: state.collapsedProjects.includes(projectId)
            ? state.collapsedProjects.filter((item) => item !== projectId)
            : [...state.collapsedProjects, projectId]
        })),
      installTheme: (theme) => {
        if (!isValidTheme(theme)) return false;
        set((state) => ({
          customThemes: state.customThemes.some((item) => item.id === theme.id)
            ? state.customThemes.map((item) => (item.id === theme.id ? theme : item))
            : [...state.customThemes, theme]
        }));
        return true;
      },
      uninstallTheme: (id) =>
        set((state) => ({
          customThemes: state.customThemes.filter((item) => item.id !== id),
          // Fall back to system if the active theme got removed.
          theme: state.theme === id ? "system" : state.theme
        })),
      setOnboardingCompleted: (onboardingCompleted) => set({ onboardingCompleted }),
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
