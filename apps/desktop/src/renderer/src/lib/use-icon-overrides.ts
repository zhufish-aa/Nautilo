import type { LucideIcon } from "lucide-react";
import { useSettingsStore } from "../stores/settings";
import { getTheme, SYSTEM_THEME_ID } from "./themes";

/** Icon override map of the active theme, if it defines any. */
export function useIconOverrides(): Record<string, LucideIcon> | undefined {
  const theme = useSettingsStore((state) => state.theme);
  const customThemes = useSettingsStore((state) => state.customThemes);
  if (theme === SYSTEM_THEME_ID) return undefined;
  return getTheme(theme, customThemes)?.icons;
}
