import type { LocaleCode } from "./utils";
import type { NavKey } from "./types";
import type { LucideIcon } from "lucide-react";
import {
  BadgeCheck,
  Bot,
  Building2,
  CircleCheck,
  CirclePlay,
  Clock,
  Cog,
  Crown,
  Folder,
  ListChecks,
  MessageCircle,
  MessageCircleHeart,
  MessageSquare,
  Rocket,
  Send,
  Sparkles,
  UserRound,
  UsersRound
} from "lucide-react";

/**
 * Theme registry — single source of truth for every theme.
 *
 * A theme is pure DATA (the same shape a future theme-market pack would
 * ship as JSON): design tokens, fonts, canvas background layers, radius
 * overrides, an optional structural-CSS snippet, localized names and a
 * preview spec. The runtime (App.tsx) turns the active definition into CSS
 * via buildThemeCss() and injects it, scoped by [data-theme="<id>"].
 *
 * Adding a theme = appending one object to BUILTIN_THEMES (or installing a
 * pack into settings.customThemes). No other file needs to change.
 */

/** Raw CSS colors for the settings-page preview (no Tailwind classes, so
 * runtime-installed packs render identically). */
export interface ThemePreviewSpec {
  /** Window background. */
  bg: string;
  /** Strong foreground bars / dots. */
  line: string;
  /** Faint bars. */
  faint: string;
  /** Window dots; defaults to three `line` dots. */
  dots?: [string, string, string];
}

export interface ThemeDefinition {
  /** Stable id, lowercase slug — used in [data-theme="<id>"]. */
  id: string;
  /** Base palette: decides the `dark` class (dark: variants) + color-scheme. */
  base: "light" | "dark";
  /** Localized display name. */
  name: Record<LocaleCode, string>;
  /** Design tokens: CSS custom property (with leading --) → value. */
  tokens: Record<string, string>;
  /** Radius overrides (Tailwind --radius-* vars). */
  radii?: Record<string, string>;
  /** Optional body font stack. */
  bodyFont?: string;
  /** Optional canvas (body) background layers. */
  canvasBackground?: {
    images: string[];
    sizes?: string;
    /** Comma-separated background-repeat / background-position lists. */
    repeats?: string;
    positions?: string;
  };
  /** Structural CSS escape hatch (chrome restyles, patterns...). Scope every
   * selector with [data-theme="<id>"]. */
  css?: string;
  /** Optional icon overrides by slot (nav keys, "composer.send", ...). */
  icons?: Record<string, LucideIcon>;
  preview: ThemePreviewSpec;
}

export const SYSTEM_THEME_ID = "system";

/* ------------------------------------------------------------------------- */
/* Built-in themes                                                            */
/* ------------------------------------------------------------------------- */

const dark: ThemeDefinition = {
  id: "dark",
  base: "dark",
  name: { "zh-CN": "深色", "en-US": "Dark" },
  // Tokens live statically in global.css (:root / .dark) so the two base
  // palettes work before JS runs and for "system"; nothing to inject here.
  tokens: {},
  preview: {
    bg: "#0d1017",
    line: "rgba(255, 255, 255, 0.25)",
    faint: "rgba(255, 255, 255, 0.1)"
  }
};

const light: ThemeDefinition = {
  id: "light",
  base: "light",
  name: { "zh-CN": "浅色", "en-US": "Light" },
  tokens: {},
  preview: {
    bg: "#f2f4f9",
    line: "rgba(0, 0, 0, 0.25)",
    faint: "rgba(0, 0, 0, 0.1)"
  }
};

const aurora: ThemeDefinition = {
  id: "aurora",
  base: "dark",
  name: { "zh-CN": "极光", "en-US": "Aurora" },
  tokens: {
    "--canvas": "#070b16",
    "--panel": "rgba(9, 14, 26, 0.78)",
    "--card": "#0c1222",
    "--card-hover": "#121a2e",
    "--line": "rgba(148, 210, 200, 0.1)",
    "--line-strong": "rgba(148, 210, 200, 0.2)",
    "--ink": "#e4f0ec",
    "--ink-2": "#9db8b4",
    "--ink-3": "#6d848a",
    "--accent": "#2dd4bf",
    "--accent-2": "#a78bfa",
    "--accent-soft": "rgba(45, 212, 191, 0.13)",
    "--on-accent": "#052e2a",
    "--ok": "#4ade80",
    "--warn": "#fbbf24",
    "--danger": "#fb7185",
    "--info": "#7dd3fc",
    "--aurora-1": "rgba(45, 212, 191, 0.16)",
    "--aurora-2": "rgba(167, 139, 250, 0.12)",
    "--grid-line": "rgba(148, 210, 200, 0.04)",
    "--shadow-card-value":
      "0 1px 2px rgba(0, 0, 0, 0.4), 0 12px 32px -16px rgba(0, 0, 0, 0.6)",
    "--shadow-pop-value":
      "0 4px 16px rgba(0, 0, 0, 0.5), 0 32px 80px -16px rgba(0, 0, 0, 0.75)",
    "--shadow-glow-value":
      "0 0 0 1px rgba(45, 212, 191, 0.35), 0 8px 40px -8px rgba(45, 212, 191, 0.5)"
  },
  preview: {
    bg: "#0c1222",
    line: "rgba(45, 212, 191, 0.6)",
    faint: "rgba(45, 212, 191, 0.2)"
  }
};

const ukiyoe: ThemeDefinition = {
  id: "ukiyoe",
  base: "light",
  name: { "zh-CN": "浮世绘", "en-US": "Ukiyo-e" },
  tokens: {
    "--canvas": "#f1e9d8",
    "--panel": "rgba(250, 245, 232, 0.8)",
    "--card": "#faf4e6",
    "--card-hover": "#fdf8ec",
    "--line": "#e0d4b8",
    "--line-strong": "#cbbc9c",
    "--ink": "#26313f",
    "--ink-2": "#4c5a6a",
    "--ink-3": "#7b8697",
    "--accent": "#c8432b",
    "--accent-2": "#2c5d8a",
    "--accent-soft": "rgba(200, 67, 43, 0.1)",
    "--on-accent": "#fdf6e8",
    "--ok": "#3e7d54",
    "--warn": "#a8731a",
    "--danger": "#b03a2e",
    "--info": "#2c5d8a",
    "--aurora-1": "rgba(44, 93, 138, 0.12)",
    "--aurora-2": "rgba(200, 67, 43, 0.09)",
    "--grid-line": "rgba(38, 49, 63, 0.045)",
    "--shadow-card-value":
      "0 1px 2px rgba(90, 64, 32, 0.06), 0 10px 28px -14px rgba(90, 64, 32, 0.18)",
    "--shadow-pop-value":
      "0 4px 14px rgba(90, 64, 32, 0.1), 0 28px 70px -18px rgba(90, 64, 32, 0.32)",
    "--shadow-glow-value":
      "0 0 0 1px rgba(200, 67, 43, 0.35), 0 6px 20px -10px rgba(90, 64, 32, 0.3)"
  },
  // Woodblock print geometry: sharp corners, nothing pillowy.
  radii: {
    "--radius-sm": "2px",
    "--radius-md": "3px",
    "--radius-lg": "4px",
    "--radius-xl": "6px",
    "--radius-2xl": "8px"
  },
  bodyFont:
    'Georgia, "Times New Roman", "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
  canvasBackground: {
    images: [
      // Vermillion sun (日の出): a crisp disc, not a wash.
      "radial-gradient(circle 130px at 88% 12%, rgba(200, 67, 43, 0.32) 0 55%, rgba(200, 67, 43, 0) 62%)",
      "radial-gradient(120% 90% at 50% -10%, rgba(44, 93, 138, 0.05), transparent 55%)",
      "radial-gradient(140% 110% at 50% 115%, rgba(120, 72, 20, 0.07), transparent 60%)",
      // Paper grain (fractal noise).
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'180\' height=\'180\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.85\' numOctaves=\'2\' stitchTiles=\'stitch\'/%3E%3CfeColorMatrix values=\'0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.035 0\'/%3E%3C/filter%3E%3Crect width=\'180\' height=\'180\' filter=\'url(%23n)\'/%3E%3C/svg%3E")',
      // Seigaiha (青海波), faint allover watermark.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'56\' height=\'28\' viewBox=\'0 0 56 28\'%3E%3Cg fill=\'none\' stroke=\'%232c5d8a\' stroke-opacity=\'0.06\'%3E%3Ccircle cx=\'0\' cy=\'28\' r=\'13\'/%3E%3Ccircle cx=\'0\' cy=\'28\' r=\'9.5\'/%3E%3Ccircle cx=\'0\' cy=\'28\' r=\'6\'/%3E%3Ccircle cx=\'0\' cy=\'28\' r=\'2.5\'/%3E%3Ccircle cx=\'28\' cy=\'28\' r=\'13\'/%3E%3Ccircle cx=\'28\' cy=\'28\' r=\'9.5\'/%3E%3Ccircle cx=\'28\' cy=\'28\' r=\'6\'/%3E%3Ccircle cx=\'28\' cy=\'28\' r=\'2.5\'/%3E%3Ccircle cx=\'56\' cy=\'28\' r=\'13\'/%3E%3Ccircle cx=\'56\' cy=\'28\' r=\'9.5\'/%3E%3Ccircle cx=\'56\' cy=\'28\' r=\'6\'/%3E%3Ccircle cx=\'56\' cy=\'28\' r=\'2.5\'/%3E%3Ccircle cx=\'14\' cy=\'0\' r=\'13\'/%3E%3Ccircle cx=\'14\' cy=\'0\' r=\'9.5\'/%3E%3Ccircle cx=\'14\' cy=\'0\' r=\'6\'/%3E%3Ccircle cx=\'14\' cy=\'0\' r=\'2.5\'/%3E%3Ccircle cx=\'42\' cy=\'0\' r=\'13\'/%3E%3Ccircle cx=\'42\' cy=\'0\' r=\'9.5\'/%3E%3Ccircle cx=\'42\' cy=\'0\' r=\'6\'/%3E%3Ccircle cx=\'42\' cy=\'0\' r=\'2.5\'/%3E%3C/g%3E%3C/svg%3E")',
      // Seigaiha wave band breaking along the bottom edge, Hokusai-style.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'56\' height=\'28\' viewBox=\'0 0 56 28\'%3E%3Cg fill=\'none\' stroke=\'%232c5d8a\' stroke-opacity=\'0.22\'%3E%3Ccircle cx=\'0\' cy=\'28\' r=\'13\'/%3E%3Ccircle cx=\'0\' cy=\'28\' r=\'9.5\'/%3E%3Ccircle cx=\'0\' cy=\'28\' r=\'6\'/%3E%3Ccircle cx=\'0\' cy=\'28\' r=\'2.5\'/%3E%3Ccircle cx=\'28\' cy=\'28\' r=\'13\'/%3E%3Ccircle cx=\'28\' cy=\'28\' r=\'9.5\'/%3E%3Ccircle cx=\'28\' cy=\'28\' r=\'6\'/%3E%3Ccircle cx=\'28\' cy=\'28\' r=\'2.5\'/%3E%3Ccircle cx=\'56\' cy=\'28\' r=\'13\'/%3E%3Ccircle cx=\'56\' cy=\'28\' r=\'9.5\'/%3E%3Ccircle cx=\'56\' cy=\'28\' r=\'6\'/%3E%3Ccircle cx=\'56\' cy=\'28\' r=\'2.5\'/%3E%3Ccircle cx=\'14\' cy=\'0\' r=\'13\'/%3E%3Ccircle cx=\'14\' cy=\'0\' r=\'9.5\'/%3E%3Ccircle cx=\'14\' cy=\'0\' r=\'6\'/%3E%3Ccircle cx=\'14\' cy=\'0\' r=\'2.5\'/%3E%3Ccircle cx=\'42\' cy=\'0\' r=\'13\'/%3E%3Ccircle cx=\'42\' cy=\'0\' r=\'9.5\'/%3E%3Ccircle cx=\'42\' cy=\'0\' r=\'6\'/%3E%3Ccircle cx=\'42\' cy=\'0\' r=\'2.5\'/%3E%3C/g%3E%3C/svg%3E")'
    ],
    sizes: "auto, auto, auto, 180px 180px, 56px 28px, auto 64px",
    repeats: "repeat, repeat, repeat, repeat, repeat, repeat-x",
    positions: "0 0, 0 0, 0 0, 0 0, 0 0, center bottom"
  },
  // Flat woodblock-print chrome: ink hairlines, paper fills, vermillion
  // seals. No gradients, no glows — everything looks stamped, not rendered.
  css: `/* Buttons: ink-outlined paper; primary is a vermillion seal. */
[data-theme="ukiyoe"] .ui-button {
  border-radius: 4px;
  border: 1px solid rgba(38, 49, 63, 0.45);
  background: transparent;
  color: #26313f;
  box-shadow: none;
  font-size: 13px;
}
[data-theme="ukiyoe"] .ui-button:hover {
  background: rgba(38, 49, 63, 0.06);
  border-color: rgba(38, 49, 63, 0.6);
  filter: none;
  box-shadow: none;
}
[data-theme="ukiyoe"] .ui-button:active {
  background: rgba(38, 49, 63, 0.1);
}
[data-theme="ukiyoe"] .ui-button-primary {
  background: #c8432b;
  border-color: #a33622;
  color: #fdf6e8;
}
[data-theme="ukiyoe"] .ui-button-primary:hover {
  background: #b23c26;
  border-color: #a33622;
}
[data-theme="ukiyoe"] .ui-button-ghost {
  border-color: transparent;
}
[data-theme="ukiyoe"] .ui-button-subtle {
  background: rgba(44, 93, 138, 0.1);
  border-color: transparent;
  color: #2c5d8a;
}
[data-theme="ukiyoe"] .ui-button-subtle:hover {
  background: rgba(44, 93, 138, 0.16);
}
[data-theme="ukiyoe"] .ui-button-danger {
  border-color: rgba(176, 58, 46, 0.5);
  color: #b03a2e;
}
[data-theme="ukiyoe"] .ui-button-danger:hover {
  background: rgba(176, 58, 46, 0.08);
}

/* Fields: rice-paper fill, ink hairline, vermillion focus mark. */
[data-theme="ukiyoe"] .ui-field {
  border-radius: 4px;
  border-color: rgba(38, 49, 63, 0.35);
  background: rgba(255, 252, 244, 0.6);
  box-shadow: none;
  font-size: 13px;
}
[data-theme="ukiyoe"] .ui-field:hover {
  border-color: rgba(38, 49, 63, 0.55);
}
[data-theme="ukiyoe"] .ui-field:focus {
  border-color: #c8432b;
  box-shadow: 0 0 0 2.5px rgba(200, 67, 43, 0.18);
}

/* Toggle: ink-wash track, indigo when on, paper knob. */
[data-theme="ukiyoe"] .ui-switch {
  height: 22px;
  width: 38px;
  border: none;
  background: rgba(38, 49, 63, 0.25);
}
[data-theme="ukiyoe"] .ui-switch[data-state="checked"] {
  background: #2c5d8a;
  background-image: none;
}
[data-theme="ukiyoe"] .ui-switch-thumb {
  height: 18px;
  width: 18px;
  translate: 2px 0;
  background: #fdf6e8;
  box-shadow: 0 1px 2px rgba(38, 49, 63, 0.35);
}
[data-theme="ukiyoe"] .ui-switch-thumb[data-state="checked"] {
  translate: 18px 0;
}

/* Cards & chips: paper sheets with ink hairlines, near-flat. */
[data-theme="ukiyoe"] .ui-card {
  border-radius: 8px;
  border-color: rgba(38, 49, 63, 0.16);
  box-shadow: 0 1px 2px rgba(90, 64, 32, 0.05);
}
[data-theme="ukiyoe"] .ui-chip,
[data-theme="ukiyoe"] .ui-tag {
  border-radius: 4px;
}

/* Bolder strokes for the woodblock feel. */
[data-theme="ukiyoe"] .lucide {
  stroke-width: 1.75;
}

/* Ink scrollbars. */
[data-theme="ukiyoe"] *::-webkit-scrollbar-thumb {
  background: rgba(38, 49, 63, 0.3);
  border: 2px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
}

/* Titlebar: paper tint; the logo badge becomes a vermillion seal (印章). */
[data-theme="ukiyoe"] .titlebar-root {
  background: rgba(243, 236, 220, 0.85);
  border-bottom-color: rgba(38, 49, 63, 0.15);
}
[data-theme="ukiyoe"] .titlebar-logo {
  background: #c8432b;
  border-radius: 3px;
  box-shadow: none;
}

/* Sidebar: aged paper, indigo-wash selection with a vermillion edge. */
[data-theme="ukiyoe"] .sidebar-rail,
[data-theme="ukiyoe"] .session-list-panel {
  background: rgba(233, 223, 201, 0.72);
  border-right-color: rgba(38, 49, 63, 0.12);
}
[data-theme="ukiyoe"] .session-list-panel [aria-current="page"] {
  background: rgba(44, 93, 138, 0.14);
  box-shadow: inset 2px 0 0 #c8432b;
}
[data-theme="ukiyoe"] .sidebar-rail a[aria-current="page"] {
  box-shadow: inset 0 0 0 1px rgba(38, 49, 63, 0.25);
}
[data-theme="ukiyoe"] .sidebar-rail a > span:not(.sr-only) {
  background: #c8432b;
  box-shadow: none;
}

/* Segmented control: paper track, stamped active segment. */
[data-theme="ukiyoe"] .mode-switch {
  border-radius: 6px;
  border-color: rgba(38, 49, 63, 0.25);
  background: rgba(38, 49, 63, 0.05);
  box-shadow: none;
}
[data-theme="ukiyoe"] .mode-switch [role="tab"] {
  border-radius: 4px;
  color: #7b8697;
}
[data-theme="ukiyoe"] .mode-switch [role="tab"][aria-selected="true"] {
  color: #26313f;
}
[data-theme="ukiyoe"] .mode-switch [role="tab"] > span[aria-hidden] {
  border-radius: 4px;
  background: #faf4e6;
  box-shadow: inset 0 0 0 1px rgba(38, 49, 63, 0.3);
}

/* User chat bubble: flat indigo print. */
[data-theme="ukiyoe"] .chat-bubble-user {
  border-radius: 10px;
  border-top-right-radius: 3px;
  border-color: rgba(38, 49, 63, 0.2);
  background: #2c5d8a;
  color: #fdf6e8;
  box-shadow: none;
}
[data-theme="ukiyoe"] .chat-bubble-user * {
  color: #fdf6e8;
}

/* Composer: paper box, vermillion focus mark, seal-style actions. */
[data-theme="ukiyoe"] .composer {
  background: rgba(243, 236, 220, 0.9);
  border-top-color: rgba(38, 49, 63, 0.15);
}
[data-theme="ukiyoe"] .composer-box {
  border-radius: 8px;
  border-color: rgba(38, 49, 63, 0.3);
  background: rgba(255, 252, 244, 0.7);
  box-shadow: none;
}
[data-theme="ukiyoe"] .composer-box:focus-within {
  border-color: #c8432b;
  box-shadow: 0 0 0 2.5px rgba(200, 67, 43, 0.15);
}
[data-theme="ukiyoe"] .composer-queue {
  border-radius: 4px;
  border: 1px solid rgba(38, 49, 63, 0.45);
  background: transparent;
  color: #26313f;
  box-shadow: none;
  font-size: 12px;
}
[data-theme="ukiyoe"] .composer-queue:hover {
  background: rgba(38, 49, 63, 0.06);
  color: #26313f;
}
[data-theme="ukiyoe"] .composer-steer {
  border-radius: 4px;
  background: #c8432b;
  color: #fdf6e8;
  font-size: 12px;
  box-shadow: none;
}
[data-theme="ukiyoe"] .composer-steer:hover {
  background: #b23c26;
}
[data-theme="ukiyoe"] .composer-send {
  border-radius: 4px;
  background: #c8432b;
  color: #fdf6e8;
  box-shadow: none;
}
[data-theme="ukiyoe"] .composer-send:hover {
  background: #b23c26;
}
[data-theme="ukiyoe"] .composer-stop {
  border-radius: 4px;
  border: 1px solid rgba(176, 58, 46, 0.5);
  background: rgba(176, 58, 46, 0.08);
  color: #b03a2e;
  box-shadow: none;
}
[data-theme="ukiyoe"] .composer-attach {
  border-radius: 4px;
}

/* Tooltip: sumi ink. */
[data-theme="ukiyoe"] .ui-tooltip {
  border: none;
  border-radius: 4px;
  background: rgba(38, 49, 63, 0.94);
  color: #f1e9d8;
  box-shadow: 0 4px 14px rgba(38, 49, 63, 0.3);
}

/* Dialog: paper sheet with an ink frame. */
[data-theme="ukiyoe"] .ui-dialog {
  border-radius: 10px;
  border-color: rgba(38, 49, 63, 0.25);
  background: rgba(250, 244, 230, 0.94);
  box-shadow: 0 24px 70px -12px rgba(60, 44, 20, 0.35);
}

/* Tabs: paper track, stamped active segment. */
[data-theme="ukiyoe"] .ui-tabs {
  border-radius: 6px;
  border-color: rgba(38, 49, 63, 0.25);
  background: rgba(38, 49, 63, 0.05);
}
[data-theme="ukiyoe"] .ui-tabs [data-state="active"],
[data-theme="ukiyoe"] .ui-tabs [aria-selected="true"] {
  border-radius: 4px;
  background: #faf4e6;
  color: #26313f;
  box-shadow: inset 0 0 0 1px rgba(38, 49, 63, 0.25);
}

/* Select: paper menu with indigo-wash highlight. */
[data-theme="ukiyoe"] .ui-select {
  border-radius: 4px;
  border-color: rgba(38, 49, 63, 0.35);
  background: rgba(255, 252, 244, 0.7);
  box-shadow: none;
  font-size: 13px;
}
[data-theme="ukiyoe"] .ui-select-content {
  border-radius: 6px;
  border-color: rgba(38, 49, 63, 0.25);
  background: rgba(250, 244, 230, 0.95);
  box-shadow: 0 12px 34px -8px rgba(60, 44, 20, 0.3);
}
[data-theme="ukiyoe"] .ui-select-content [data-highlighted] {
  border-radius: 3px;
  background: rgba(44, 93, 138, 0.14);
  color: #26313f;
}

/* Toast: stamped paper card. */
[data-theme="ukiyoe"] .ui-toast {
  border-radius: 8px;
  border-color: rgba(38, 49, 63, 0.2);
  background: rgba(250, 244, 230, 0.96);
  box-shadow: 0 12px 32px -8px rgba(60, 44, 20, 0.28);
}

/* Soft paper vibrancy where surfaces overlay the pattern. */
[data-theme="ukiyoe"] .titlebar-root,
[data-theme="ukiyoe"] .sidebar-rail,
[data-theme="ukiyoe"] .session-list-panel,
[data-theme="ukiyoe"] .composer,
[data-theme="ukiyoe"] .ui-dialog,
[data-theme="ukiyoe"] .ui-select-content {
  -webkit-backdrop-filter: blur(16px) saturate(1.1);
  backdrop-filter: blur(16px) saturate(1.1);
}

/* Let the seigaiha waves and grain show through the chat canvas. */
[data-theme="ukiyoe"] .energy-field {
  background: transparent;
}
[data-theme="ukiyoe"] .energy-field::before {
  opacity: 0;
}

/* --- Print composition ------------------------------------------------------
 * Indigo stays in the small accents (bubbles, selection, seals) — the big
 * surfaces remain paper, like a real print. */
/* Vertical title down the rail, like a print's signature column (落款). */
[data-theme="ukiyoe"] .sidebar-rail::after {
  content: "浮世繪";
  position: absolute;
  bottom: 72px;
  left: 50%;
  transform: translateX(-50%);
  writing-mode: vertical-rl;
  font-size: 15px;
  letter-spacing: 8px;
  color: rgba(44, 93, 138, 0.35);
  pointer-events: none;
}

/* The logo seal gets its character: 浮 in paper white. */
[data-theme="ukiyoe"] .titlebar-logo svg {
  display: none;
}
[data-theme="ukiyoe"] .titlebar-logo::after {
  content: "浮";
  color: #fdf6e8;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}`,
  preview: {
    bg: "#f1e9d8",
    line: "rgba(200, 67, 43, 0.7)",
    faint: "rgba(44, 93, 138, 0.25)"
  }
};

const macos: ThemeDefinition = {
  id: "macos",
  base: "light",
  name: { "zh-CN": "Mac 风", "en-US": "macOS" },
  tokens: {
    "--canvas": "#f5f5f7",
    "--panel": "rgba(255, 255, 255, 0.68)",
    "--card": "#ffffff",
    "--card-hover": "#f7f7f9",
    "--line": "rgba(0, 0, 0, 0.07)",
    "--line-strong": "rgba(0, 0, 0, 0.14)",
    "--ink": "#1d1d1f",
    "--ink-2": "#494950",
    "--ink-3": "#86868b",
    "--accent": "#0071e3",
    "--accent-2": "#42a4f5",
    "--accent-soft": "rgba(0, 113, 227, 0.1)",
    "--on-accent": "#ffffff",
    "--ok": "#248a3d",
    "--warn": "#ad5700",
    "--danger": "#d70015",
    "--info": "#007aff",
    "--aurora-1": "transparent",
    "--aurora-2": "transparent",
    "--grid-line": "transparent",
    "--shadow-card-value":
      "0 1px 2px rgba(0, 0, 0, 0.04), 0 12px 32px -12px rgba(0, 0, 0, 0.12)",
    "--shadow-pop-value":
      "0 6px 16px rgba(0, 0, 0, 0.08), 0 32px 80px -20px rgba(0, 0, 0, 0.22)",
    "--shadow-glow-value":
      "0 0 0 1px rgba(0, 0, 0, 0.14), 0 8px 32px -8px rgba(0, 0, 0, 0.2)"
  },
  // macOS control radii: small controls ~6px, cards/sheets ~10px.
  radii: {
    "--radius-sm": "4px",
    "--radius-md": "5px",
    "--radius-lg": "6px",
    "--radius-xl": "8px",
    "--radius-2xl": "10px"
  },
  bodyFont:
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro SC", "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  // Structural chrome: traffic lights (close/min/zoom order, glyphs on group
  // hover), full-height Finder sidebar (titlebar split-tinted at the sidebar
  // seam), centered window title, gray sidebar selection, flat canvas.
  css: `[data-theme="macos"] .titlebar-root {
  justify-content: flex-start;
  /* Sidebar gray left of the 64px seam (the always-present icon rail),
   * content tint right of it — fakes macOS's full-height sidebar under the
   * lights without breaking pages that have no session list. */
  background: linear-gradient(
    to right,
    rgba(238, 238, 243, 0.72) 0,
    rgba(238, 238, 243, 0.72) 64px,
    rgba(250, 250, 252, 0.72) 64px
  );
  border-bottom-color: rgba(0, 0, 0, 0.08);
}
[data-theme="macos"] .titlebar-brand {
  /* macOS centers the window title in the toolbar — both axes. */
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}
[data-theme="macos"] .titlebar-logo,
[data-theme="macos"] .titlebar-tagline {
  /* macOS window titles are a single short line — no badge, no tagline. */
  display: none;
}
[data-theme="macos"] .titlebar-name {
  /* ...rendered small, mid-gray, medium weight. */
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: #6e6e73;
}
[data-theme="macos"] .lucide {
  /* SF-Symbols-like thin icon strokes across the whole UI. */
  stroke-width: 1.5;
}
[data-theme="macos"] .titlebar-controls {
  order: -1;
  align-items: center;
  gap: 8px;
  padding: 0 6px 0 12px;
}
[data-theme="macos"] .titlebar-controls [data-window] {
  position: relative;
  height: 12px;
  width: 12px;
  border-radius: 999px;
  color: transparent;
  box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.18);
}
[data-theme="macos"] .titlebar-controls [data-window] svg {
  display: none;
}
[data-theme="macos"] .titlebar-controls [data-window="close"] {
  order: 1;
  background: #ff5f57;
}
[data-theme="macos"] .titlebar-controls [data-window="minimize"] {
  order: 2;
  background: #febc2e;
}
[data-theme="macos"] .titlebar-controls [data-window="maximize"] {
  order: 3;
  background: #28c840;
}
[data-theme="macos"] .titlebar-controls [data-window]::after {
  content: "";
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  color: rgba(0, 0, 0, 0.55);
  opacity: 0;
  transition: opacity 120ms ease;
}
[data-theme="macos"] .titlebar-controls [data-window="close"]::after {
  content: "\\00d7"; /* × */
}
[data-theme="macos"] .titlebar-controls [data-window="minimize"]::after {
  content: "\\2013"; /* – */
}
[data-theme="macos"] .titlebar-controls [data-window="maximize"]::after {
  content: "+";
}
[data-theme="macos"] .titlebar-controls:hover [data-window]::after,
[data-theme="macos"] .titlebar-controls [data-window]:focus-visible::after {
  opacity: 1;
}
[data-theme="macos"] .sidebar-rail,
[data-theme="macos"] .session-list-panel {
  /* One unified Finder-gray sidebar: same fill, hairline separators only.
   * Translucent enough for the vibrancy blur below to read through. */
  background: rgba(238, 238, 243, 0.72);
  border-right-color: rgba(0, 0, 0, 0.06);
}
[data-theme="macos"] .session-list-panel [aria-current="page"] {
  /* macOS sidebar selection is a quiet gray wash, not an accent pill. */
  background: rgba(0, 0, 0, 0.07);
  box-shadow: none;
}
[data-theme="macos"] .energy-field {
  /* macOS windows are flat — no ambient glow behind the content. */
  background: var(--canvas);
}
[data-theme="macos"] .energy-field::before {
  opacity: 0;
}
[data-theme="macos"] .sidebar-rail a[aria-current="page"] {
  /* Replace the violet glow pill with a quiet pressed-button look. */
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.05),
    inset 0 0 0 1px rgba(0, 0, 0, 0.06);
}
[data-theme="macos"] .sidebar-rail a > span:not(.sr-only) {
  /* macOS sidebars have no accent tick next to the active item. */
  display: none;
}
/* Blue belongs to controls (buttons, toggles, links), not decoration:
 * neutralize accent-tinted surfaces so the theme stops reading "all blue". */
[data-theme="macos"] .bg-accent-soft {
  background-color: rgba(0, 0, 0, 0.05);
}
[data-theme="macos"] .hover\:bg-accent-soft:hover {
  background-color: rgba(0, 0, 0, 0.06);
}

/* --- macOS native control kit ---------------------------------------------
 * Buttons: 6px radius, 13px label, hairline border, off-white gradient for
 * default, solid system blue for primary (no violet gradient, no glow). */
[data-theme="macos"] .ui-button {
  border-radius: 6px;
  font-size: 13px;
  border: 0.5px solid rgba(0, 0, 0, 0.16);
  background: linear-gradient(180deg, #ffffff, #f3f3f3);
  color: #1d1d1f;
  box-shadow: 0 0.5px 1.5px rgba(0, 0, 0, 0.12);
}
[data-theme="macos"] .ui-button:hover {
  background: linear-gradient(180deg, #fafafa, #ececec);
  border-color: rgba(0, 0, 0, 0.22);
  box-shadow: 0 0.5px 1.5px rgba(0, 0, 0, 0.14);
  filter: none;
}
[data-theme="macos"] .ui-button:active {
  background: #e4e4e4;
}
[data-theme="macos"] .ui-button-primary {
  background: #007aff;
  border-color: rgba(0, 0, 0, 0.14);
  color: #ffffff;
}
[data-theme="macos"] .ui-button-primary:hover {
  background: #1a86ff;
  box-shadow: 0 0.5px 1.5px rgba(0, 0, 0, 0.18);
}
[data-theme="macos"] .ui-button-primary:active {
  background: #0062cc;
}
[data-theme="macos"] .ui-button-ghost {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}
[data-theme="macos"] .ui-button-ghost:hover {
  background: rgba(0, 0, 0, 0.05);
}
[data-theme="macos"] .ui-button-subtle {
  background: rgba(0, 0, 0, 0.05);
  border-color: transparent;
  color: #1d1d1f;
  box-shadow: none;
}
[data-theme="macos"] .ui-button-subtle:hover {
  background: rgba(0, 0, 0, 0.08);
}
[data-theme="macos"] .ui-button-danger {
  background: linear-gradient(180deg, #ffffff, #f3f3f3);
  border-color: rgba(215, 0, 21, 0.4);
  color: #d70015;
}
[data-theme="macos"] .ui-button-danger:hover {
  background: rgba(215, 0, 21, 0.08);
  border-color: rgba(215, 0, 21, 0.55);
}

/* Text fields: 6px radius, white, hairline border, macOS blue focus halo. */
[data-theme="macos"] .ui-field {
  border-radius: 6px;
  border-color: rgba(0, 0, 0, 0.15);
  background: #ffffff;
  font-size: 13px;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.04);
}
[data-theme="macos"] .ui-field:hover {
  border-color: rgba(0, 0, 0, 0.25);
}
[data-theme="macos"] .ui-field:focus {
  border-color: #007aff;
  box-shadow: 0 0 0 3.5px rgba(0, 122, 255, 0.28);
}

/* Toggle: macOS pill — gray track, solid blue when on, plain white knob. */
[data-theme="macos"] .ui-switch {
  height: 22px;
  width: 38px;
  border: none;
  background: rgba(120, 120, 128, 0.32);
}
[data-theme="macos"] .ui-switch[data-state="checked"] {
  background: #007aff;
  background-image: none;
}
[data-theme="macos"] .ui-switch-thumb {
  height: 18px;
  width: 18px;
  /* Tailwind v4 translate-x-* uses the "translate" property — override that,
   * not "transform", or the two would add up and fling the knob off track. */
  translate: 2px 0;
  box-shadow:
    0 2px 4px rgba(0, 0, 0, 0.2),
    0 0 1px rgba(0, 0, 0, 0.12);
}
[data-theme="macos"] .ui-switch-thumb[data-state="checked"] {
  translate: 18px 0;
}

/* Cards & chips: 10px sheets, 6px chips, hairline borders, near-flat shadow. */
[data-theme="macos"] .ui-card {
  border-radius: 10px;
  border-color: rgba(0, 0, 0, 0.07);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
[data-theme="macos"] .ui-chip,
[data-theme="macos"] .ui-tag {
  border-radius: 6px;
}

/* macOS base text is 13px. */
[data-theme="macos"] .text-sm {
  font-size: 13px;
}

/* Thin overlay-style scrollbars. */
[data-theme="macos"] *::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
[data-theme="macos"] *::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.25);
  border: 2px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
}
[data-theme="macos"] *::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.4);
  border: 2px solid transparent;
  background-clip: padding-box;
}

/* --- Remaining surfaces ---------------------------------------------------- */
/* Segmented control (Code/Work): gray track, white sliding segment. */
[data-theme="macos"] .mode-switch {
  border-radius: 8px;
  border-color: rgba(0, 0, 0, 0.08);
  background: rgba(0, 0, 0, 0.05);
  box-shadow: none;
  padding: 2px;
}
[data-theme="macos"] .mode-switch [role="tab"] {
  border-radius: 6px;
  height: 22px;
  font-size: 11px;
  color: #6e6e73;
}
[data-theme="macos"] .mode-switch [role="tab"]:hover {
  background: transparent;
  color: #1d1d1f;
}
[data-theme="macos"] .mode-switch [role="tab"][aria-selected="true"] {
  color: #1d1d1f;
}
[data-theme="macos"] .mode-switch [role="tab"] > span[aria-hidden] {
  border-radius: 6px;
  background: #ffffff;
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.16),
    0 0 0 0.5px rgba(0, 0, 0, 0.05);
}

/* User chat bubble: Messages.app — system blue, white text, deep radius. */
[data-theme="macos"] .chat-bubble-user {
  border-radius: 18px;
  border-top-right-radius: 4px;
  border-color: transparent;
  background: #007aff;
  color: #ffffff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}
[data-theme="macos"] .chat-bubble-user * {
  color: #ffffff;
}

/* Composer: macOS focus halo instead of the accent glow. */
[data-theme="macos"] .composer {
  background: rgba(250, 250, 252, 0.9);
  border-top-color: rgba(0, 0, 0, 0.07);
}
[data-theme="macos"] .composer-box {
  border-radius: 10px;
  border-color: rgba(0, 0, 0, 0.12);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}
[data-theme="macos"] .composer-box:focus-within {
  border-color: #007aff;
  box-shadow: 0 0 0 3.5px rgba(0, 122, 255, 0.22);
}

/* Tooltip: dark translucent, macOS style. */
[data-theme="macos"] .ui-tooltip {
  border: none;
  border-radius: 6px;
  background: rgba(50, 50, 54, 0.92);
  color: #f5f5f7;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
}

/* Dialog: macOS sheet — 12px radius, deep but soft shadow, dimmed overlay. */
[data-theme="macos"] .ui-dialog {
  border-radius: 12px;
  border-color: rgba(0, 0, 0, 0.1);
  box-shadow:
    0 0 0 0.5px rgba(0, 0, 0, 0.08),
    0 24px 70px -12px rgba(0, 0, 0, 0.35);
}

/* Tabs: macOS segmented look — gray track, white active segment. */
[data-theme="macos"] .ui-tabs {
  border-radius: 8px;
  border-color: rgba(0, 0, 0, 0.08);
  background: rgba(0, 0, 0, 0.05);
}
[data-theme="macos"] .ui-tabs [data-state="active"],
[data-theme="macos"] .ui-tabs [aria-selected="true"] {
  border-radius: 6px;
  background: #ffffff;
  color: #1d1d1f;
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.16),
    0 0 0 0.5px rgba(0, 0, 0, 0.05);
}

/* Select: trigger matches the button kit; dropdown is a macOS menu —
 * highlighted rows go system blue with white text. */
[data-theme="macos"] .ui-select {
  border-radius: 6px;
  border-color: rgba(0, 0, 0, 0.16);
  background: linear-gradient(180deg, #ffffff, #f3f3f3);
  box-shadow: 0 0.5px 1.5px rgba(0, 0, 0, 0.12);
  font-size: 13px;
}
[data-theme="macos"] .ui-select-content {
  border-radius: 8px;
  border-color: rgba(0, 0, 0, 0.1);
  box-shadow:
    0 0 0 0.5px rgba(0, 0, 0, 0.06),
    0 12px 34px -8px rgba(0, 0, 0, 0.28);
}
[data-theme="macos"] .ui-select-content [data-highlighted] {
  border-radius: 5px;
  background: #007aff;
  color: #ffffff;
}
[data-theme="macos"] .ui-select-content [data-highlighted] .select-hint {
  color: rgba(255, 255, 255, 0.75);
}

/* Toast: macOS notification — rounder sheet, soft deep shadow. */
[data-theme="macos"] .ui-toast {
  border-radius: 12px;
  border-color: rgba(0, 0, 0, 0.08);
  box-shadow:
    0 0 0 0.5px rgba(0, 0, 0, 0.05),
    0 12px 32px -8px rgba(0, 0, 0, 0.25);
}

/* --- Composer action buttons ---------------------------------------------- */
/* Queue: macOS default button (white gradient, hairline, 6px). */
[data-theme="macos"] .composer-queue {
  border-radius: 6px;
  border: 0.5px solid rgba(0, 0, 0, 0.16);
  background: linear-gradient(180deg, #ffffff, #f3f3f3);
  color: #1d1d1f;
  box-shadow: 0 0.5px 1.5px rgba(0, 0, 0, 0.12);
  font-size: 12px;
}
[data-theme="macos"] .composer-queue:hover {
  background: linear-gradient(180deg, #fafafa, #ececec);
  color: #1d1d1f;
}
/* Steer: solid system blue, like a macOS default action. */
[data-theme="macos"] .composer-steer {
  border-radius: 6px;
  background: #007aff;
  color: #ffffff;
  font-size: 12px;
  box-shadow: 0 0.5px 1.5px rgba(0, 0, 0, 0.16);
}
[data-theme="macos"] .composer-steer:hover {
  background: #1a86ff;
}
/* Send: Messages.app — blue circle, white arrow. */
[data-theme="macos"] .composer-send {
  background: #007aff;
  color: #ffffff;
}
[data-theme="macos"] .composer-send:hover {
  background: #1a86ff;
}
/* Stop: quiet macOS destructive button. */
[data-theme="macos"] .composer-stop {
  border-radius: 6px;
  border: 0.5px solid rgba(215, 0, 21, 0.4);
  background: rgba(215, 0, 21, 0.08);
  color: #d70015;
  box-shadow: none;
}
[data-theme="macos"] .composer-stop:hover {
  background: rgba(215, 0, 21, 0.16);
}
[data-theme="macos"] .composer-attach {
  border-radius: 6px;
}

/* --- Vibrancy (毛玻璃) ------------------------------------------------------
 * macOS sidebar/toolbar/sheet materials: blur + saturate behind translucent
 * fills (fills were lowered to ~0.72 alpha above so the blur reads). */
[data-theme="macos"] .titlebar-root,
[data-theme="macos"] .sidebar-rail,
[data-theme="macos"] .session-list-panel,
[data-theme="macos"] .composer,
[data-theme="macos"] .ui-dialog,
[data-theme="macos"] .ui-select-content,
[data-theme="macos"] .ui-tooltip {
  -webkit-backdrop-filter: blur(28px) saturate(1.8);
  backdrop-filter: blur(28px) saturate(1.8);
}
[data-theme="macos"] .ui-dialog {
  background: rgba(255, 255, 255, 0.85);
}
[data-theme="macos"] .ui-select-content {
  background: rgba(250, 250, 252, 0.88);
}

/* --- Motion polish ---------------------------------------------------------- */
/* Traffic lights magnify slightly on hover. */
[data-theme="macos"] .titlebar-controls [data-window] {
  transition: transform 140ms ease;
}
[data-theme="macos"] .titlebar-controls [data-window]:hover {
  transform: scale(1.15);
}
/* Nav icons pop with a gentle spring. */
[data-theme="macos"] .sidebar-rail a[data-nav] {
  transition:
    transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1),
    background-color 120ms ease,
    box-shadow 160ms ease;
}
[data-theme="macos"] .sidebar-rail a[data-nav]:hover {
  transform: scale(1.08);
}
/* Menu rows snap between highlight states. */
[data-theme="macos"] .ui-select-content [role="option"] {
  transition:
    background-color 90ms ease,
    color 90ms ease;
}`,
  preview: {
    bg: "#f5f5f7",
    line: "rgba(0, 0, 0, 0.3)",
    faint: "rgba(0, 0, 0, 0.1)",
    dots: ["#ff5f57", "#febc2e", "#28c840"]
  },
  // SF-Symbols-flavored glyphs: Finder folder, person, checkmark.circle,
  // bubble, play.circle, gearshape.
  icons: {
    projects: Folder,
    agents: UserRound,
    teams: UsersRound,
    tasks: CircleCheck,
    sessions: MessageCircle,
    runs: CirclePlay,
    settings: Cog,
    // SF: paperplane for steer-now, clock for queued follow-ups.
    "composer.steer": Send,
    "composer.queue": Clock
  }
};

const terminal: ThemeDefinition = {
  id: "terminal",
  base: "dark",
  name: { "zh-CN": "终端", "en-US": "Terminal" },
  tokens: {
    "--canvas": "#0e100f",
    "--panel": "rgba(14, 16, 15, 0.85)",
    "--card": "#141816",
    "--card-hover": "#1a1f1c",
    "--line": "rgba(126, 231, 135, 0.12)",
    "--line-strong": "rgba(126, 231, 135, 0.26)",
    "--ink": "#e8f5ea",
    "--ink-2": "#a9c4ae",
    "--ink-3": "#6f8a76",
    "--accent": "#3fb950",
    "--accent-2": "#26a35c",
    "--accent-soft": "rgba(63, 185, 80, 0.12)",
    "--on-accent": "#06130a",
    "--ok": "#3fb950",
    "--warn": "#e5c07b",
    "--danger": "#ff5f56",
    "--info": "#56b6c2",
    "--aurora-1": "rgba(63, 185, 80, 0.12)",
    "--aurora-2": "rgba(86, 182, 194, 0.07)",
    "--grid-line": "rgba(126, 231, 135, 0.05)",
    "--shadow-card-value": "0 1px 2px rgba(0, 0, 0, 0.5)",
    "--shadow-pop-value":
      "0 4px 16px rgba(0, 0, 0, 0.55), 0 24px 64px -16px rgba(0, 0, 0, 0.8)",
    "--shadow-glow-value":
      "0 0 0 1px rgba(63, 185, 80, 0.4), 0 0 24px rgba(63, 185, 80, 0.25)"
  },
  // Blocky CRT geometry.
  radii: {
    "--radius-sm": "0px",
    "--radius-md": "2px",
    "--radius-lg": "2px",
    "--radius-xl": "2px",
    "--radius-2xl": "4px"
  },
  // Monospaced latin, proper CJK fallback — a terminal, but readable Chinese.
  bodyFont:
    '"JetBrains Mono", "Cascadia Code", "SF Mono", Consolas, "PingFang SC", "Microsoft YaHei", monospace',
  canvasBackground: {
    images: [
      // Phosphor glow pooling at the top.
      "radial-gradient(100% 55% at 50% 0%, rgba(63, 185, 80, 0.07), transparent 70%)",
      // CRT scanlines — faint, wide-spaced.
      "repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.12) 0 1px, transparent 1px 4px)"
    ],
    sizes: "auto, auto"
  },
  css: `/* Barely-there phosphor glow — present, but never smears text. */
[data-theme="terminal"] body {
  text-shadow: 0 0 4px rgba(63, 185, 80, 0.08);
}
[data-theme="terminal"] .ui-button {
  border-radius: 2px;
  border: 1px solid rgba(126, 231, 135, 0.35);
  background: transparent;
  color: #a9c4ae;
  box-shadow: none;
}
[data-theme="terminal"] .ui-button:hover {
  background: rgba(63, 185, 80, 0.1);
  color: #d9f2de;
  filter: none;
  box-shadow: none;
}
[data-theme="terminal"] .ui-button-primary {
  background: #3fb950;
  border-color: #3fb950;
  color: #06130a;
  font-weight: 600;
}
[data-theme="terminal"] .ui-button-primary:hover {
  background: #56d364;
}
[data-theme="terminal"] .ui-button-ghost {
  border-color: transparent;
}
[data-theme="terminal"] .ui-button-subtle {
  background: rgba(63, 185, 80, 0.1);
  border-color: transparent;
  color: #3fb950;
}
[data-theme="terminal"] .ui-button-danger {
  border-color: rgba(255, 95, 86, 0.4);
  color: #ff5f56;
}
[data-theme="terminal"] .ui-field {
  border-radius: 2px;
  border-color: rgba(126, 231, 135, 0.35);
  background: rgba(63, 185, 80, 0.04);
  box-shadow: none;
}
[data-theme="terminal"] .ui-field:focus {
  border-color: #3fb950;
  box-shadow:
    0 0 0 2px rgba(63, 185, 80, 0.15),
    0 0 12px rgba(63, 185, 80, 0.15);
}
[data-theme="terminal"] .ui-switch {
  height: 22px;
  width: 38px;
  border: none;
  background: rgba(126, 231, 135, 0.2);
}
[data-theme="terminal"] .ui-switch[data-state="checked"] {
  background: #3fb950;
  background-image: none;
}
[data-theme="terminal"] .ui-switch-thumb {
  height: 18px;
  width: 18px;
  translate: 2px 0;
  background: #d9f2de;
}
[data-theme="terminal"] .ui-switch-thumb[data-state="checked"] {
  translate: 18px 0;
}
[data-theme="terminal"] .ui-card {
  border-radius: 2px;
  border-color: rgba(126, 231, 135, 0.13);
  box-shadow: none;
}
[data-theme="terminal"] .ui-chip,
[data-theme="terminal"] .ui-tag {
  border-radius: 2px;
}
[data-theme="terminal"] *::-webkit-scrollbar-thumb {
  background: rgba(63, 185, 80, 0.35);
  border: 2px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
}
[data-theme="terminal"] .titlebar-root {
  background: rgba(14, 16, 15, 0.9);
  border-bottom-color: rgba(126, 231, 135, 0.25);
}
[data-theme="terminal"] .sidebar-rail,
[data-theme="terminal"] .session-list-panel {
  background: rgba(14, 16, 15, 0.6);
  border-right-color: rgba(126, 231, 135, 0.15);
}
[data-theme="terminal"] .session-list-panel [aria-current="page"] {
  background: rgba(63, 185, 80, 0.12);
  box-shadow: inset 2px 0 0 #3fb950;
}
[data-theme="terminal"] .sidebar-rail a[aria-current="page"] {
  box-shadow: inset 0 0 0 1px rgba(63, 185, 80, 0.4);
}
[data-theme="terminal"] .mode-switch,
[data-theme="terminal"] .ui-tabs {
  border-radius: 2px;
  border-color: rgba(126, 231, 135, 0.3);
  background: rgba(63, 185, 80, 0.05);
}
[data-theme="terminal"] .mode-switch [role="tab"][aria-selected="true"],
[data-theme="terminal"] .ui-tabs [data-state="active"],
[data-theme="terminal"] .ui-tabs [aria-selected="true"] {
  border-radius: 2px;
  background: rgba(63, 185, 80, 0.16);
  color: #3fb950;
  box-shadow: inset 0 0 0 1px rgba(63, 185, 80, 0.4);
}
[data-theme="terminal"] .mode-switch [role="tab"] > span[aria-hidden] {
  border-radius: 2px;
  background: rgba(63, 185, 80, 0.16);
  box-shadow: inset 0 0 0 1px rgba(63, 185, 80, 0.4);
}
[data-theme="terminal"] .mode-switch [role="tab"][aria-selected="true"] {
  color: #3fb950;
}
[data-theme="terminal"] .chat-bubble-user {
  border-radius: 2px;
  border: 1px solid rgba(126, 231, 135, 0.4);
  background: rgba(63, 185, 80, 0.08);
  color: #d9f2de;
  box-shadow: none;
}
[data-theme="terminal"] .chat-bubble-user * {
  color: #d9f2de;
}
[data-theme="terminal"] .composer-box {
  border-radius: 2px;
  border-color: rgba(126, 231, 135, 0.35);
  box-shadow: none;
}
[data-theme="terminal"] .composer-box:focus-within {
  border-color: #3fb950;
  box-shadow:
    0 0 0 2px rgba(63, 185, 80, 0.15),
    0 0 12px rgba(63, 185, 80, 0.12);
}
[data-theme="terminal"] .composer-queue,
[data-theme="terminal"] .composer-attach {
  border-radius: 2px;
}
[data-theme="terminal"] .composer-steer,
[data-theme="terminal"] .composer-send {
  border-radius: 2px;
  background: #3fb950;
  color: #06130a;
  box-shadow: none;
}
[data-theme="terminal"] .composer-stop {
  border-radius: 2px;
}
[data-theme="terminal"] .ui-tooltip {
  border: 1px solid rgba(126, 231, 135, 0.3);
  border-radius: 2px;
  background: rgba(8, 14, 8, 0.95);
  color: #a9c4ae;
  box-shadow: none;
}
[data-theme="terminal"] .ui-dialog {
  border-radius: 4px;
  border-color: rgba(126, 231, 135, 0.3);
  background: rgba(13, 20, 13, 0.97);
}
[data-theme="terminal"] .ui-select {
  border-radius: 2px;
  border-color: rgba(126, 231, 135, 0.35);
  background: rgba(63, 185, 80, 0.04);
  box-shadow: none;
}
[data-theme="terminal"] .ui-select-content {
  border-radius: 2px;
  border-color: rgba(126, 231, 135, 0.3);
  background: #141816;
}
[data-theme="terminal"] .ui-select-content [data-highlighted] {
  border-radius: 2px;
  background: rgba(63, 185, 80, 0.15);
  color: #3fb950;
}
[data-theme="terminal"] .ui-select-content [data-highlighted] .select-hint {
  color: #4f8a60;
}
[data-theme="terminal"] .ui-toast {
  border-radius: 2px;
  border-color: rgba(126, 231, 135, 0.3);
}
[data-theme="terminal"] .energy-field {
  background: transparent;
}
[data-theme="terminal"] .energy-field::before {
  opacity: 0;
}`,
  preview: {
    bg: "#141816",
    line: "rgba(63, 185, 80, 0.7)",
    faint: "rgba(63, 185, 80, 0.25)"
  }
};

const dusk: ThemeDefinition = {
  id: "dusk",
  base: "dark",
  name: { "zh-CN": "黄昏", "en-US": "Dusk" },
  tokens: {
    "--canvas": "#1a1220",
    "--panel": "rgba(30, 20, 36, 0.8)",
    "--card": "#241a2c",
    "--card-hover": "#2d2136",
    "--line": "rgba(255, 179, 128, 0.1)",
    "--line-strong": "rgba(255, 179, 128, 0.2)",
    "--ink": "#f5e6dd",
    "--ink-2": "#c4a99e",
    "--ink-3": "#947b74",
    "--accent": "#ff8c5a",
    "--accent-2": "#ffb347",
    "--accent-soft": "rgba(255, 140, 90, 0.13)",
    "--on-accent": "#2a1408",
    "--ok": "#7ddba3",
    "--warn": "#ffc857",
    "--danger": "#ff6b7a",
    "--info": "#c98bff",
    "--aurora-1": "rgba(255, 140, 90, 0.14)",
    "--aurora-2": "rgba(201, 139, 255, 0.1)",
    "--grid-line": "rgba(255, 179, 128, 0.04)",
    "--shadow-card-value":
      "0 1px 2px rgba(0, 0, 0, 0.35), 0 10px 28px -14px rgba(0, 0, 0, 0.5)",
    "--shadow-pop-value":
      "0 4px 16px rgba(0, 0, 0, 0.45), 0 28px 72px -16px rgba(0, 0, 0, 0.7)",
    "--shadow-glow-value":
      "0 0 0 1px rgba(255, 140, 90, 0.35), 0 8px 36px -8px rgba(255, 140, 90, 0.45)"
  },
  // Soft, pillowy sunset geometry.
  radii: {
    "--radius-sm": "6px",
    "--radius-md": "8px",
    "--radius-lg": "10px",
    "--radius-xl": "14px",
    "--radius-2xl": "18px"
  },
  canvasBackground: {
    images: [
      // Deep violet zenith.
      "linear-gradient(180deg, rgba(46, 24, 66, 0.55), transparent 45%)",
      // Warm horizon glow sinking below the bottom edge.
      "radial-gradient(130% 60% at 50% 118%, rgba(255, 140, 90, 0.2), transparent 62%)",
      // First stars pricking through.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'200\' height=\'200\'%3E%3Cg fill=\'%23ffffff\'%3E%3Ccircle cx=\'24\' cy=\'32\' r=\'0.8\' opacity=\'0.5\'/%3E%3Ccircle cx=\'96\' cy=\'18\' r=\'0.6\' opacity=\'0.35\'/%3E%3Ccircle cx=\'150\' cy=\'48\' r=\'0.9\' opacity=\'0.4\'/%3E%3Ccircle cx=\'58\' cy=\'84\' r=\'0.6\' opacity=\'0.3\'/%3E%3Ccircle cx=\'182\' cy=\'96\' r=\'0.7\' opacity=\'0.35\'/%3E%3Ccircle cx=\'40\' cy=\'150\' r=\'0.8\' opacity=\'0.3\'/%3E%3Ccircle cx=\'120\' cy=\'130\' r=\'0.6\' opacity=\'0.25\'/%3E%3Ccircle cx=\'170\' cy=\'170\' r=\'0.9\' opacity=\'0.3\'/%3E%3Ccircle cx=\'80\' cy=\'188\' r=\'0.6\' opacity=\'0.25\'/%3E%3Ccircle cx=\'10\' cy=\'110\' r=\'0.7\' opacity=\'0.3\'/%3E%3C/g%3E%3C/svg%3E")'
    ],
    sizes: "auto, auto, 200px 200px"
  },
  css: `[data-theme="dusk"] .ui-button {
  border: 1px solid rgba(255, 179, 128, 0.25);
  background: transparent;
  color: #c4a99e;
  box-shadow: none;
}
[data-theme="dusk"] .ui-button:hover {
  background: rgba(255, 140, 90, 0.1);
  color: #f5e6dd;
  filter: none;
}
[data-theme="dusk"] .ui-button-primary {
  background: linear-gradient(135deg, #ff8c5a, #ffb347);
  border-color: transparent;
  color: #2a1408;
  box-shadow: 0 4px 16px -6px rgba(255, 140, 90, 0.5);
}
[data-theme="dusk"] .ui-button-primary:hover {
  box-shadow: 0 6px 22px -6px rgba(255, 140, 90, 0.65);
}
[data-theme="dusk"] .ui-button-ghost {
  border-color: transparent;
}
[data-theme="dusk"] .ui-button-subtle {
  background: rgba(255, 140, 90, 0.12);
  border-color: transparent;
  color: #ffb347;
}
[data-theme="dusk"] .ui-button-danger {
  border-color: rgba(255, 107, 122, 0.4);
  color: #ff6b7a;
}
[data-theme="dusk"] .ui-field {
  border-color: rgba(255, 179, 128, 0.25);
  background: rgba(255, 179, 128, 0.05);
  box-shadow: none;
}
[data-theme="dusk"] .ui-field:focus {
  border-color: #ff8c5a;
  box-shadow: 0 0 0 3px rgba(255, 140, 90, 0.2);
}
[data-theme="dusk"] .ui-switch {
  height: 22px;
  width: 38px;
  border: none;
  background: rgba(255, 179, 128, 0.25);
}
[data-theme="dusk"] .ui-switch[data-state="checked"] {
  background: #ff8c5a;
  background-image: none;
}
[data-theme="dusk"] .ui-switch-thumb {
  height: 18px;
  width: 18px;
  translate: 2px 0;
  background: #fff5ec;
}
[data-theme="dusk"] .ui-switch-thumb[data-state="checked"] {
  translate: 18px 0;
}
[data-theme="dusk"] .ui-card {
  border-color: rgba(255, 179, 128, 0.12);
}
[data-theme="dusk"] *::-webkit-scrollbar-thumb {
  background: rgba(255, 179, 128, 0.3);
  border: 2px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
}
[data-theme="dusk"] .session-list-panel [aria-current="page"] {
  background: rgba(255, 140, 90, 0.14);
  box-shadow: inset 2px 0 0 #ff8c5a;
}
[data-theme="dusk"] .sidebar-rail a[aria-current="page"] {
  box-shadow: inset 0 0 0 1px rgba(255, 140, 90, 0.4);
}
[data-theme="dusk"] .mode-switch [role="tab"] > span[aria-hidden] {
  background: rgba(255, 140, 90, 0.16);
  box-shadow: inset 0 0 0 1px rgba(255, 140, 90, 0.35);
}
[data-theme="dusk"] .mode-switch [role="tab"][aria-selected="true"] {
  color: #ffb347;
}
[data-theme="dusk"] .ui-tabs [data-state="active"],
[data-theme="dusk"] .ui-tabs [aria-selected="true"] {
  background: rgba(255, 140, 90, 0.16);
  color: #ffb347;
  box-shadow: inset 0 0 0 1px rgba(255, 140, 90, 0.35);
}
[data-theme="dusk"] .chat-bubble-user {
  border-color: transparent;
  background: linear-gradient(135deg, #ff8c5a, #ff7a6b);
  color: #2a1408;
  box-shadow: 0 4px 16px -6px rgba(255, 140, 90, 0.45);
}
[data-theme="dusk"] .chat-bubble-user * {
  color: #2a1408;
}
[data-theme="dusk"] .composer-box:focus-within {
  border-color: #ff8c5a;
  box-shadow: 0 0 0 3px rgba(255, 140, 90, 0.18);
}
[data-theme="dusk"] .composer-steer,
[data-theme="dusk"] .composer-send {
  background: linear-gradient(135deg, #ff8c5a, #ffb347);
  color: #2a1408;
  box-shadow: 0 4px 16px -6px rgba(255, 140, 90, 0.5);
}
[data-theme="dusk"] .ui-tooltip {
  border: 1px solid rgba(255, 179, 128, 0.2);
  background: rgba(36, 26, 44, 0.95);
  color: #f5e6dd;
}
[data-theme="dusk"] .ui-dialog {
  border-color: rgba(255, 179, 128, 0.15);
}
[data-theme="dusk"] .ui-select-content [data-highlighted] {
  background: rgba(255, 140, 90, 0.16);
  color: #ffb347;
}
[data-theme="dusk"] .ui-select-content [data-highlighted] .select-hint {
  color: #947b74;
}
/* Let the stars and horizon glow show through the chat canvas. */
[data-theme="dusk"] .energy-field {
  background: transparent;
}
[data-theme="dusk"] .energy-field::before {
  opacity: 0;
}`,
  preview: {
    bg: "#241a2c",
    line: "rgba(255, 140, 90, 0.7)",
    faint: "rgba(255, 179, 128, 0.25)"
  }
};

/**
 * Art Deco (盖茨比) — the heavyweight showpiece theme.
 *
 * Design language: warm near-black velvet, champagne ink, real gold
 * gradients (never flat yellow), deep emerald as the counterpoint color.
 * Geometry is stepped and fanned — sunburst rays pour from the titlebar,
 * a scalloped fan pattern wallpapers the canvas, a Chrysler-style stepped
 * skyline walks the bottom edge, and every frame uses the era's signature
 * double gold rule. Corners stay sharp; motion is a slow metallic shimmer,
 * not a bounce.
 */
const deco: ThemeDefinition = {
  id: "deco",
  base: "dark",
  name: { "zh-CN": "盖茨比", "en-US": "Gatsby" },
  tokens: {
    "--canvas": "#0c0b08",
    "--panel": "rgba(20, 17, 12, 0.82)",
    "--card": "#15120d",
    "--card-hover": "#1c1811",
    "--line": "rgba(216, 178, 90, 0.14)",
    "--line-strong": "rgba(216, 178, 90, 0.3)",
    "--ink": "#efe3c6",
    "--ink-2": "#b8a888",
    "--ink-3": "#7d7258",
    "--accent": "#d4af37",
    "--accent-2": "#2f8f6f",
    "--accent-soft": "rgba(212, 175, 55, 0.12)",
    "--on-accent": "#241c08",
    "--ok": "#4caf7d",
    "--warn": "#d9a441",
    "--danger": "#d97b5f",
    "--info": "#8fa8c9",
    "--aurora-1": "rgba(212, 175, 55, 0.1)",
    "--aurora-2": "rgba(47, 143, 111, 0.08)",
    "--grid-line": "rgba(216, 178, 90, 0.05)",
    "--shadow-card-value":
      "0 1px 2px rgba(0, 0, 0, 0.55), 0 12px 32px -14px rgba(0, 0, 0, 0.7)",
    "--shadow-pop-value":
      "0 4px 16px rgba(0, 0, 0, 0.6), 0 32px 80px -18px rgba(0, 0, 0, 0.85)",
    "--shadow-glow-value":
      "0 0 0 1px rgba(212, 175, 55, 0.4), 0 8px 36px -8px rgba(212, 175, 55, 0.35)"
  },
  // Stepped, architectural geometry — nothing rounded and soft.
  radii: {
    "--radius-sm": "2px",
    "--radius-md": "3px",
    "--radius-lg": "4px",
    "--radius-xl": "6px",
    "--radius-2xl": "8px"
  },
  // Engraved serif latin, Song-style CJK fallback.
  bodyFont:
    '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
  canvasBackground: {
    images: [
      // Sunburst rays pouring down from above the titlebar.
      "repeating-conic-gradient(from -90deg at 50% -18%, rgba(212, 175, 55, 0.055) 0deg 2.5deg, transparent 2.5deg 13deg)",
      // Scalloped deco fans with spokes, wallpaper-faint.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'64\' height=\'32\' viewBox=\'0 0 64 32\'%3E%3Cg fill=\'none\' stroke=\'%23d4af37\' stroke-opacity=\'0.06\'%3E%3Cpath d=\'M0 32 A16 16 0 0 1 32 32\'/%3E%3Cpath d=\'M5 32 A11 11 0 0 1 27 32\'/%3E%3Cpath d=\'M10 32 A6 6 0 0 1 22 32\'/%3E%3Cpath d=\'M16 32 L16 18\'/%3E%3Cpath d=\'M7 23 L16 32\'/%3E%3Cpath d=\'M25 23 L16 32\'/%3E%3Cpath d=\'M32 32 A16 16 0 0 1 64 32\'/%3E%3Cpath d=\'M37 32 A11 11 0 0 1 59 32\'/%3E%3Cpath d=\'M42 32 A6 6 0 0 1 54 32\'/%3E%3Cpath d=\'M48 32 L48 18\'/%3E%3Cpath d=\'M39 23 L48 32\'/%3E%3Cpath d=\'M57 23 L48 32\'/%3E%3C/g%3E%3C/svg%3E")',
      // Stepped skyscraper skyline along the bottom edge.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'240\' height=\'84\' viewBox=\'0 0 240 84\'%3E%3Cg fill=\'%23d4af37\' fill-opacity=\'0.07\'%3E%3Cpath d=\'M8 84 V58 h14 V44 h10 V30 h6 V14 h4 V6 h4 v8 h4 v16 h6 v14 h10 v14 h14 V84 Z\'/%3E%3Cpath d=\'M108 84 V64 h16 V50 h12 V36 h8 V22 h4 V10 h4 v12 h4 v14 h8 v14 h12 v14 h16 V84 Z\'/%3E%3Cpath d=\'M192 84 V62 h12 V48 h10 V34 h6 V20 h4 v14 h6 v14 h10 V84 Z\'/%3E%3C/g%3E%3C/svg%3E")',
      // Diamond lattice with a pin-dot at each crossing.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'28\' height=\'28\' viewBox=\'0 0 28 28\'%3E%3Cpath d=\'M14 0 L28 14 L14 28 L0 14 Z\' fill=\'none\' stroke=\'%23d4af37\' stroke-opacity=\'0.04\'/%3E%3Ccircle cx=\'14\' cy=\'14\' r=\'0.9\' fill=\'%23d4af37\' fill-opacity=\'0.08\'/%3E%3C/svg%3E")',
      // Film grain.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'180\' height=\'180\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.85\' numOctaves=\'2\' stitchTiles=\'stitch\'/%3E%3CfeColorMatrix values=\'0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.04 0\'/%3E%3C/filter%3E%3Crect width=\'180\' height=\'180\' filter=\'url(%23n)\'/%3E%3C/svg%3E")',
      // Vignette pulling the edges into shadow.
      "radial-gradient(120% 90% at 50% 40%, transparent 55%, rgba(0, 0, 0, 0.5) 100%)"
    ],
    sizes: "100% 460px, 64px 32px, auto 84px, 28px 28px, 180px 180px, auto",
    repeats: "no-repeat, repeat, repeat-x, repeat, repeat, repeat",
    positions: "center top, 0 0, center bottom, 0 0, 0 0, 0 0"
  },
  css: `/* --- Foundation ---------------------------------------------------------- */
[data-theme="deco"] ::selection {
  background: rgba(212, 175, 55, 0.85);
  color: #241c08;
}
[data-theme="deco"] body {
  caret-color: #d4af37;
}
[data-theme="deco"] :focus-visible {
  outline: 1px solid rgba(212, 175, 55, 0.7);
  outline-offset: 2px;
}

/* --- Buttons --------------------------------------------------------------
 * Gradient gold borders via the padding-box / border-box trick: the metal
 * runs light-to-dark along the diagonal, like a milled brass frame. */
[data-theme="deco"] .ui-button {
  border-radius: 3px;
  border: 1px solid transparent;
  background:
    linear-gradient(#191510, #191510) padding-box,
    linear-gradient(165deg, rgba(240, 217, 137, 0.7), rgba(110, 86, 28, 0.55)) border-box;
  color: #d9c9a0;
  box-shadow: none;
  font-size: 13px;
  letter-spacing: 0.05em;
  transition: filter 160ms ease, box-shadow 160ms ease;
}
[data-theme="deco"] .ui-button:hover {
  filter: brightness(1.18);
  box-shadow: 0 0 14px -4px rgba(212, 175, 55, 0.35);
}
[data-theme="deco"] .ui-button:active {
  filter: brightness(0.95);
}
[data-theme="deco"] .ui-button-primary {
  position: relative;
  overflow: hidden;
  border-color: rgba(240, 217, 137, 0.8);
  background: linear-gradient(180deg, #eccd6f 0%, #cfa63a 48%, #a8842a 52%, #c39a2e 100%);
  color: #241c08;
  font-weight: 600;
  box-shadow:
    inset 0 1px 0 rgba(255, 244, 204, 0.7),
    0 4px 18px -6px rgba(212, 175, 55, 0.5);
}
/* The travelling sheen across pressed brass. */
[data-theme="deco"] .ui-button-primary::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: -60%;
  width: 40%;
  background: linear-gradient(100deg, transparent, rgba(255, 246, 214, 0.55), transparent);
  transform: skewX(-18deg);
  transition: left 520ms ease;
  pointer-events: none;
}
[data-theme="deco"] .ui-button-primary:hover::before {
  left: 120%;
}
[data-theme="deco"] .ui-button-ghost {
  background: transparent;
  border-color: transparent;
}
[data-theme="deco"] .ui-button-ghost:hover {
  background: rgba(212, 175, 55, 0.08);
  box-shadow: none;
}
[data-theme="deco"] .ui-button-subtle {
  background: rgba(47, 143, 111, 0.14);
  border-color: rgba(47, 143, 111, 0.35);
  color: #6fcea8;
}
[data-theme="deco"] .ui-button-subtle:hover {
  background: rgba(47, 143, 111, 0.22);
}
[data-theme="deco"] .ui-button-danger {
  border-color: rgba(217, 123, 95, 0.45);
  color: #d97b5f;
}
[data-theme="deco"] .ui-button-danger:hover {
  background: rgba(217, 123, 95, 0.1);
}

/* --- Fields --------------------------------------------------------------- */
[data-theme="deco"] .ui-field {
  border-radius: 3px;
  border-color: rgba(216, 178, 90, 0.3);
  background: rgba(212, 175, 55, 0.04);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.5);
  font-size: 13px;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
[data-theme="deco"] .ui-field::placeholder {
  color: #6b6148;
  font-style: italic;
}
[data-theme="deco"] .ui-field:hover {
  border-color: rgba(216, 178, 90, 0.45);
}
[data-theme="deco"] .ui-field:focus {
  border-color: #d4af37;
  box-shadow:
    0 0 0 3px rgba(212, 175, 55, 0.16),
    0 0 18px -4px rgba(212, 175, 55, 0.3);
}

/* --- Toggle: brass track, ivory knob ------------------------------------- */
[data-theme="deco"] .ui-switch {
  height: 22px;
  width: 38px;
  border: 1px solid rgba(216, 178, 90, 0.35);
  background: #14110b;
}
[data-theme="deco"] .ui-switch[data-state="checked"] {
  border-color: rgba(240, 217, 137, 0.7);
  background: linear-gradient(180deg, #e6c566, #a8842a);
}
[data-theme="deco"] .ui-switch-thumb {
  height: 16px;
  width: 16px;
  translate: 2px 0;
  background: #f2e6c8;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}
[data-theme="deco"] .ui-switch-thumb[data-state="checked"] {
  translate: 17px 0;
  background: #241c08;
}

/* --- Cards, chips, tags ---------------------------------------------------- */
[data-theme="deco"] .ui-card {
  border-radius: 6px;
  border-color: rgba(216, 178, 90, 0.18);
  background: linear-gradient(180deg, rgba(212, 175, 55, 0.035), transparent 34%), #15120d;
  box-shadow:
    inset 0 1px 0 rgba(240, 217, 137, 0.1),
    0 12px 32px -16px rgba(0, 0, 0, 0.8);
}
[data-theme="deco"] .ui-chip,
[data-theme="deco"] .ui-tag {
  border-radius: 2px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 10px;
}

/* Engraved line icons. */
[data-theme="deco"] .lucide {
  stroke-width: 1.5;
}

/* --- Scrollbars ------------------------------------------------------------ */
[data-theme="deco"] *::-webkit-scrollbar-thumb {
  background: rgba(212, 175, 55, 0.28);
  border: 3px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
}
[data-theme="deco"] *::-webkit-scrollbar-thumb:hover {
  background: rgba(212, 175, 55, 0.45);
  border: 3px solid transparent;
  background-clip: padding-box;
}

/* --- Titlebar ---------------------------------------------------------------
 * Velvet bar with the era's double gold rule underneath; the brand mark
 * becomes a rotated gold ingot; the wordmark is a slow shimmering foil. */
[data-theme="deco"] .titlebar-root {
  position: relative;
  background: linear-gradient(180deg, #16130d, #0e0c08);
  border-bottom: 1px solid rgba(212, 175, 55, 0.4);
}
[data-theme="deco"] .titlebar-root::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 3px;
  height: 1px;
  background: rgba(212, 175, 55, 0.18);
  pointer-events: none;
}
[data-theme="deco"] .titlebar-logo {
  border-radius: 2px;
  background: linear-gradient(150deg, #eccd6f, #a8842a);
  box-shadow: 0 0 10px rgba(212, 175, 55, 0.45);
  transform: rotate(45deg) scale(0.72);
}
[data-theme="deco"] .titlebar-logo svg {
  display: none;
}
[data-theme="deco"] .titlebar-logo::after {
  content: "";
  width: 44%;
  height: 44%;
  border-radius: 1px;
  background: #12100b;
}
[data-theme="deco"] .titlebar-name {
  background: linear-gradient(90deg, #8a6d24, #f0d989 40%, #fff6d6 50%, #f0d989 60%, #8a6d24);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
  text-transform: uppercase;
  letter-spacing: 0.32em;
  font-weight: 600;
  animation: deco-title-shimmer 7s linear infinite;
}
[data-theme="deco"] .titlebar-tagline {
  color: #7d7258;
  letter-spacing: 0.18em;
}
[data-theme="deco"] .titlebar-controls [data-window] {
  border-radius: 2px;
  transition: background-color 140ms ease;
}
[data-theme="deco"] .titlebar-controls [data-window]:hover {
  background: rgba(212, 175, 55, 0.14);
}
[data-theme="deco"] .titlebar-controls [data-window="close"]:hover {
  background: rgba(200, 85, 61, 0.85);
  color: #fdf6e8;
}
@keyframes deco-title-shimmer {
  0% { background-position: 0% 0; }
  100% { background-position: 200% 0; }
}

/* --- Sidebar & session list -------------------------------------------------
 * Black velvet; the current destination is picked out with a gold fillet
 * and a corner-lit glow. A vertical signature column signs the rail. */
[data-theme="deco"] .sidebar-rail,
[data-theme="deco"] .session-list-panel {
  background: linear-gradient(180deg, #12100a, #0d0b07);
  border-right-color: rgba(216, 178, 90, 0.2);
}
[data-theme="deco"] .sidebar-rail::after {
  content: "裝飾藝術";
  position: absolute;
  bottom: 72px;
  left: 50%;
  transform: translateX(-50%);
  writing-mode: vertical-rl;
  font-size: 13px;
  letter-spacing: 9px;
  color: rgba(212, 175, 55, 0.38);
  pointer-events: none;
}
[data-theme="deco"] .sidebar-rail a[data-nav] {
  border-radius: 3px;
  transition: background-color 140ms ease, box-shadow 160ms ease;
}
[data-theme="deco"] .sidebar-rail a[data-nav] .lucide {
  color: #7d7258;
  transition: color 140ms ease;
}
[data-theme="deco"] .sidebar-rail a[data-nav]:hover {
  background: rgba(212, 175, 55, 0.07);
}
[data-theme="deco"] .sidebar-rail a[data-nav]:hover .lucide {
  color: #d4af37;
}
[data-theme="deco"] .sidebar-rail a[aria-current="page"] {
  background: rgba(212, 175, 55, 0.1);
  box-shadow: inset 0 0 0 1px rgba(212, 175, 55, 0.45);
}
[data-theme="deco"] .sidebar-rail a[aria-current="page"] .lucide {
  color: #e6c566;
}
[data-theme="deco"] .sidebar-rail a > span:not(.sr-only) {
  background: linear-gradient(150deg, #eccd6f, #a8842a);
  box-shadow: 0 0 8px rgba(212, 175, 55, 0.4);
}
[data-theme="deco"] .session-list-panel [aria-current="page"] {
  background: linear-gradient(90deg, rgba(212, 175, 55, 0.14), transparent 72%);
  box-shadow: inset 3px 0 0 #d4af37;
}

/* --- Segmented controls & tabs ---------------------------------------------
 * The active segment is a solid brass plate with engraved dark text. */
[data-theme="deco"] .mode-switch,
[data-theme="deco"] .ui-tabs {
  border-radius: 4px;
  border-color: rgba(216, 178, 90, 0.3);
  background: rgba(212, 175, 55, 0.05);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.5);
}
[data-theme="deco"] .mode-switch [role="tab"] {
  border-radius: 3px;
  color: #8d8060;
  letter-spacing: 0.06em;
}
[data-theme="deco"] .mode-switch [role="tab"] > span[aria-hidden] {
  border-radius: 3px;
  background: linear-gradient(180deg, #e6c566, #b08d2c);
  box-shadow:
    inset 0 1px 0 rgba(255, 244, 204, 0.6),
    inset 0 0 0 1px rgba(240, 217, 137, 0.5);
}
[data-theme="deco"] .mode-switch [role="tab"][aria-selected="true"] {
  color: #241c08;
  font-weight: 600;
}
[data-theme="deco"] .ui-tabs [data-state="active"],
[data-theme="deco"] .ui-tabs [aria-selected="true"] {
  border-radius: 3px;
  background: rgba(212, 175, 55, 0.14);
  color: #e6c566;
  box-shadow: inset 0 0 0 1px rgba(212, 175, 55, 0.4);
}

/* --- Chat bubbles -------------------------------------------------------------
 * The user speaks from an emerald lacquer panel with a gold fillet — the
 * one saturated counterpoint in a gold-on-black room. */
[data-theme="deco"] .chat-bubble-user {
  border-radius: 10px;
  border-top-right-radius: 2px;
  border: 1px solid rgba(212, 175, 55, 0.5);
  background: linear-gradient(155deg, #17594b, #0d3c33);
  color: #f2e8d0;
  box-shadow:
    inset 0 1px 0 rgba(240, 217, 137, 0.18),
    0 6px 20px -8px rgba(13, 60, 51, 0.9);
}
[data-theme="deco"] .chat-bubble-user * {
  color: #f2e8d0;
}

/* --- Composer ---------------------------------------------------------------- */
[data-theme="deco"] .composer {
  background: linear-gradient(180deg, rgba(18, 15, 10, 0.94), rgba(12, 10, 7, 0.97));
  border-top: 1px solid rgba(212, 175, 55, 0.3);
}
[data-theme="deco"] .composer-box {
  border-radius: 6px;
  border-color: rgba(216, 178, 90, 0.32);
  background: rgba(212, 175, 55, 0.035);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.55);
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
[data-theme="deco"] .composer-box:focus-within {
  border-color: #d4af37;
  box-shadow:
    0 0 0 3px rgba(212, 175, 55, 0.14),
    0 0 22px -6px rgba(212, 175, 55, 0.35);
}
[data-theme="deco"] .composer-queue {
  border-radius: 3px;
  border: 1px solid rgba(216, 178, 90, 0.4);
  background: transparent;
  color: #d9c9a0;
  box-shadow: none;
  font-size: 12px;
  letter-spacing: 0.05em;
}
[data-theme="deco"] .composer-queue:hover {
  background: rgba(212, 175, 55, 0.08);
  color: #efe3c6;
}
[data-theme="deco"] .composer-attach {
  border-radius: 3px;
}
[data-theme="deco"] .composer-steer,
[data-theme="deco"] .composer-send {
  border-radius: 3px;
  border: 1px solid rgba(240, 217, 137, 0.75);
  background: linear-gradient(180deg, #eccd6f, #b08d2c);
  color: #241c08;
  font-weight: 600;
  letter-spacing: 0.05em;
  box-shadow:
    inset 0 1px 0 rgba(255, 244, 204, 0.65),
    0 4px 14px -6px rgba(212, 175, 55, 0.55);
}
[data-theme="deco"] .composer-steer:hover,
[data-theme="deco"] .composer-send:hover {
  filter: brightness(1.1);
}
[data-theme="deco"] .composer-stop {
  border-radius: 3px;
  border: 1px solid rgba(217, 123, 95, 0.5);
  background: rgba(217, 123, 95, 0.1);
  color: #d97b5f;
  box-shadow: none;
}

/* --- Overlays: tooltip, dialog, select, toast -------------------------------- */
[data-theme="deco"] .ui-tooltip {
  border: 1px solid rgba(216, 178, 90, 0.35);
  border-radius: 3px;
  background: rgba(14, 12, 8, 0.96);
  color: #d9c9a0;
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.8);
  letter-spacing: 0.04em;
}
/* The stepped double frame: gold hairline, shadow gap, second hairline. */
[data-theme="deco"] .ui-dialog {
  border-radius: 6px;
  border: 1px solid rgba(212, 175, 55, 0.45);
  background: linear-gradient(180deg, #17140e, #100e09);
  box-shadow:
    0 0 0 4px #0c0a07,
    0 0 0 5px rgba(212, 175, 55, 0.22),
    0 30px 80px -20px rgba(0, 0, 0, 0.9);
}
[data-theme="deco"] .ui-select {
  border-radius: 3px;
  border-color: rgba(216, 178, 90, 0.3);
  background: rgba(212, 175, 55, 0.04);
  box-shadow: none;
  font-size: 13px;
}
[data-theme="deco"] .ui-select-content {
  border-radius: 4px;
  border-color: rgba(216, 178, 90, 0.35);
  background: rgba(18, 15, 10, 0.97);
  box-shadow:
    0 0 0 3px rgba(12, 10, 7, 0.9),
    0 16px 44px -10px rgba(0, 0, 0, 0.85);
}
[data-theme="deco"] .ui-select-content [data-highlighted] {
  border-radius: 2px;
  background: rgba(212, 175, 55, 0.14);
  color: #e6c566;
}
[data-theme="deco"] .ui-select-content [data-highlighted] .select-hint {
  color: #8d8060;
}
[data-theme="deco"] .ui-toast {
  border-radius: 4px;
  border-color: rgba(216, 178, 90, 0.3);
  background: rgba(20, 17, 11, 0.97);
  box-shadow:
    inset 3px 0 0 #d4af37,
    0 14px 36px -10px rgba(0, 0, 0, 0.85);
}

/* Vibrancy: frosted velvet over the patterned canvas. */
[data-theme="deco"] .titlebar-root,
[data-theme="deco"] .sidebar-rail,
[data-theme="deco"] .session-list-panel,
[data-theme="deco"] .composer,
[data-theme="deco"] .ui-dialog,
[data-theme="deco"] .ui-select-content {
  -webkit-backdrop-filter: blur(18px) saturate(1.15);
  backdrop-filter: blur(18px) saturate(1.15);
}

/* Let the fans, skyline and sunburst show through the chat canvas. */
[data-theme="deco"] .energy-field {
  background: transparent;
}
[data-theme="deco"] .energy-field::before {
  opacity: 0;
}

/* --- Motion ------------------------------------------------------------------
 * Everything metallic glides; nothing bounces. Honors reduced motion. */
[data-theme="deco"] .ui-card {
  transition: border-color 180ms ease, box-shadow 180ms ease;
}
[data-theme="deco"] .ui-card:hover {
  border-color: rgba(216, 178, 90, 0.32);
}
[data-theme="deco"] .session-list-panel [aria-current="page"],
[data-theme="deco"] .mode-switch [role="tab"],
[data-theme="deco"] .ui-tabs [role="tab"] {
  transition: color 150ms ease, background-color 150ms ease, box-shadow 150ms ease;
}
@media (prefers-reduced-motion: reduce) {
  [data-theme="deco"] .titlebar-name {
    animation: none;
  }
  [data-theme="deco"] .ui-button-primary::before {
    transition: none;
  }
}`,
  preview: {
    bg: "#14110c",
    line: "rgba(212, 175, 55, 0.75)",
    faint: "rgba(212, 175, 55, 0.28)",
    dots: ["#e6c566", "#b08d2c", "#5c4c1e"]
  },
  // Skyscraper, crown and engraved-plaque glyphs to match the period.
  icons: {
    projects: Building2,
    agents: Crown,
    teams: UsersRound,
    tasks: BadgeCheck,
    sessions: MessageSquare,
    runs: CirclePlay,
    settings: Cog,
    "composer.steer": Send,
    "composer.queue": Clock
  }
};

/**
 * Sticker Pop (波普贴纸) — the playful showpiece.
 *
 * Design language: warm cream paper, chunky ink outlines, hard offset
 * shadows and a candy trio (bubblegum pink, sunny yellow, sky blue).
 * Everything looks die-cut: stickers lift toward the cursor on a springy
 * bezier and press flat when clicked. Corners are chunky, icons are
 * thick-stroked, and confetti + wavy lines keep the canvas in motion
 * without ever getting noisy.
 */
const pop: ThemeDefinition = {
  id: "pop",
  base: "light",
  name: { "zh-CN": "波普贴纸", "en-US": "Sticker Pop" },
  tokens: {
    "--canvas": "#fcf1dd",
    "--panel": "rgba(255, 250, 240, 0.88)",
    "--card": "#fffdf6",
    "--card-hover": "#ffffff",
    "--line": "rgba(38, 34, 28, 0.12)",
    "--line-strong": "rgba(38, 34, 28, 0.22)",
    "--ink": "#26221c",
    "--ink-2": "#5c554a",
    "--ink-3": "#8d8474",
    "--accent": "#ff5d8f",
    "--accent-2": "#ffc531",
    "--accent-soft": "rgba(255, 93, 143, 0.12)",
    "--on-accent": "#ffffff",
    "--ok": "#2fa36b",
    "--warn": "#e8a013",
    "--danger": "#e5484d",
    "--info": "#4d96ff",
    "--aurora-1": "rgba(255, 93, 143, 0.12)",
    "--aurora-2": "rgba(77, 150, 255, 0.1)",
    // The AppShell mesh would fight the confetti paper — turn it off.
    "--grid-line": "transparent",
    "--shadow-card-value": "3px 3px 0 rgba(38, 34, 28, 0.12)",
    "--shadow-pop-value": "6px 6px 0 rgba(38, 34, 28, 0.18)",
    "--shadow-glow-value":
      "0 0 0 2px rgba(255, 93, 143, 0.4), 4px 4px 0 rgba(38, 34, 28, 0.2)"
  },
  // Chunky die-cut corners.
  radii: {
    "--radius-sm": "6px",
    "--radius-md": "8px",
    "--radius-lg": "10px",
    "--radius-xl": "14px",
    "--radius-2xl": "18px"
  },
  // Rounded sans latin, rounded-gothic CJK fallback.
  bodyFont:
    'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Nunito", "Hiragino Maru Gothic ProN", "Yuanti SC", "YouYuan", "Microsoft YaHei", sans-serif',
  canvasBackground: {
    images: [
      // Bubblegum glow warming the top edge.
      "radial-gradient(90% 40% at 50% 0%, rgba(255, 93, 143, 0.09), transparent 70%)",
      // A big yellow sparkle winking from the top-right corner.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'120\' height=\'120\' viewBox=\'0 0 120 120\'%3E%3Cpath d=\'M60 6 L70 50 L114 60 L70 70 L60 114 L50 70 L6 60 L50 50 Z\' fill=\'%23ffc531\' fill-opacity=\'0.3\'/%3E%3C/svg%3E")',
      // A chunky pink ring parked near the bottom-left.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'140\' height=\'140\' viewBox=\'0 0 140 140\'%3E%3Ccircle cx=\'70\' cy=\'70\' r=\'50\' fill=\'none\' stroke=\'%23ff5d8f\' stroke-opacity=\'0.2\' stroke-width=\'12\'/%3E%3C/svg%3E")',
      // Confetti: candy shapes, rings, plus-signs, squiggles — clearly visible.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'200\' height=\'200\' viewBox=\'0 0 200 200\'%3E%3Cg fill=\'none\'%3E%3Ccircle cx=\'30\' cy=\'34\' r=\'6\' fill=\'%23ff5d8f\' fill-opacity=\'0.28\'/%3E%3Cpath d=\'M96 20 l8 14 h-16 Z\' fill=\'%23ffc531\' fill-opacity=\'0.3\'/%3E%3Crect x=\'150\' y=\'30\' width=\'12\' height=\'12\' rx=\'3\' transform=\'rotate(18 156 36)\' fill=\'%234d96ff\' fill-opacity=\'0.26\'/%3E%3Cpath d=\'M22 104 q5 -7 10 0 t10 0\' stroke=\'%234d96ff\' stroke-opacity=\'0.28\' stroke-width=\'2.5\' stroke-linecap=\'round\'/%3E%3Ccircle cx=\'102\' cy=\'90\' r=\'7\' stroke=\'%23ff5d8f\' stroke-opacity=\'0.24\' stroke-width=\'2.5\'/%3E%3Cpath d=\'M162 100 v14 M155 107 h14\' stroke=\'%23ffc531\' stroke-opacity=\'0.32\' stroke-width=\'3\' stroke-linecap=\'round\'/%3E%3Cpath d=\'M44 160 l7 12 h-14 Z\' fill=\'%234d96ff\' fill-opacity=\'0.24\'/%3E%3Ccircle cx=\'128\' cy=\'156\' r=\'5\' fill=\'%23ffc531\' fill-opacity=\'0.3\'/%3E%3Crect x=\'74\' y=\'134\' width=\'10\' height=\'10\' rx=\'2\' transform=\'rotate(-14 79 139)\' fill=\'%23ff5d8f\' fill-opacity=\'0.22\'/%3E%3Cpath d=\'M154 160 q5 -7 10 0 t10 0\' stroke=\'%23ff5d8f\' stroke-opacity=\'0.26\' stroke-width=\'2.5\' stroke-linecap=\'round\'/%3E%3Ccircle cx=\'66\' cy=\'60\' r=\'5\' stroke=\'%23ffc531\' stroke-opacity=\'0.26\' stroke-width=\'2.5\'/%3E%3Cpath d=\'M16 170 v10 M11 175 h10\' stroke=\'%234d96ff\' stroke-opacity=\'0.26\' stroke-width=\'2.5\' stroke-linecap=\'round\'/%3E%3C/g%3E%3C/svg%3E")',
      // Ink dot grid keeping the paper structured.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'26\' height=\'26\' viewBox=\'0 0 26 26\'%3E%3Ccircle cx=\'13\' cy=\'13\' r=\'1.4\' fill=\'%2326221c\' fill-opacity=\'0.08\'/%3E%3C/svg%3E")',
      // Two candy waves skipping along the bottom edge, out of phase.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'48\' height=\'26\' viewBox=\'0 0 48 26\'%3E%3Cpath d=\'M0 13 q6 -8 12 0 t12 0 t12 0 t12 0\' fill=\'none\' stroke=\'%23ff5d8f\' stroke-opacity=\'0.3\' stroke-width=\'3\' stroke-linecap=\'round\'/%3E%3C/svg%3E")',
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'48\' height=\'26\' viewBox=\'0 0 48 26\'%3E%3Cpath d=\'M0 13 q6 8 12 0 t12 0 t12 0 t12 0\' fill=\'none\' stroke=\'%234d96ff\' stroke-opacity=\'0.22\' stroke-width=\'3\' stroke-linecap=\'round\'/%3E%3C/svg%3E")'
    ],
    sizes: "auto, 120px 120px, 140px 140px, 200px 200px, 26px 26px, auto 26px, auto 26px",
    repeats: "repeat, no-repeat, no-repeat, repeat, repeat, repeat-x, repeat-x",
    positions: "0 0, right 28px top 72px, left 24px bottom 108px, 0 0, 0 0, center bottom, center bottom 14px"
  },
  css: `/* --- Foundation ---------------------------------------------------------- */
[data-theme="pop"] ::selection {
  background: #ffc531;
  color: #26221c;
}
[data-theme="pop"] body {
  caret-color: #ff5d8f;
}
[data-theme="pop"] :focus-visible {
  outline: 2px dashed #ff5d8f;
  outline-offset: 2px;
}
/* Text inputs already flash their own sticker frame on focus — a dashed
 * outline on top just draws a second box inside the composer. */
[data-theme="pop"] textarea:focus-visible,
[data-theme="pop"] input:focus-visible,
[data-theme="pop"] [contenteditable]:focus-visible {
  outline: none;
}

/* Sub-agent avatars: die-cut pink sticker instead of the violet gradient. */
[data-theme="pop"] .agent-avatar {
  border: 2px solid #26221c;
  border-radius: 10px;
  background: #ffe3ec;
  color: #ff5d8f;
  box-shadow: 2px 2px 0 #26221c;
  transform: rotate(-3deg);
}

/* --- Buttons --------------------------------------------------------------
 * Die-cut stickers: white vinyl, 2px ink outline, hard offset shadow.
 * Hover lifts the sticker toward the cursor; press flattens it back. */
[data-theme="pop"] .ui-button {
  border-radius: 10px;
  border: 2px solid #26221c;
  background: #fffdf6;
  color: #26221c;
  box-shadow: 3px 3px 0 #26221c;
  font-size: 13px;
  font-weight: 600;
  transition:
    transform 130ms cubic-bezier(0.34, 1.56, 0.64, 1),
    box-shadow 130ms cubic-bezier(0.34, 1.56, 0.64, 1),
    background-color 120ms ease;
}
[data-theme="pop"] .ui-button:hover {
  transform: translate(-1px, -1px);
  box-shadow: 4px 4px 0 #26221c;
  filter: none;
}
[data-theme="pop"] .ui-button:active {
  transform: translate(2px, 2px);
  box-shadow: 1px 1px 0 #26221c;
}
[data-theme="pop"] .ui-button-primary {
  background: #ff5d8f;
  color: #ffffff;
}
[data-theme="pop"] .ui-button-primary:hover {
  background: #ff6f9d;
}
[data-theme="pop"] .ui-button-ghost {
  border-color: transparent;
  box-shadow: none;
  background: transparent;
}
[data-theme="pop"] .ui-button-ghost:hover {
  background: rgba(255, 93, 143, 0.1);
  box-shadow: none;
  transform: none;
}
[data-theme="pop"] .ui-button-subtle {
  background: #ffe9a8;
  color: #26221c;
}
[data-theme="pop"] .ui-button-subtle:hover {
  background: #ffdf82;
}
[data-theme="pop"] .ui-button-danger {
  color: #e5484d;
}
[data-theme="pop"] .ui-button-danger:hover {
  background: #ffe4e5;
}

/* --- Fields --------------------------------------------------------------- */
[data-theme="pop"] .ui-field {
  border-radius: 10px;
  border: 2px solid #26221c;
  background: #ffffff;
  box-shadow: 2px 2px 0 rgba(38, 34, 28, 0.15);
  font-size: 13px;
  transition: box-shadow 130ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
[data-theme="pop"] .ui-field::placeholder {
  color: #a89e8d;
}
[data-theme="pop"] .ui-field:focus {
  border-color: #26221c;
  box-shadow: 3px 3px 0 #ff5d8f;
}

/* --- Toggle: candy track, gum-ball knob ------------------------------------ */
[data-theme="pop"] .ui-switch {
  height: 24px;
  width: 42px;
  border: 2px solid #26221c;
  background: #ffffff;
}
[data-theme="pop"] .ui-switch[data-state="checked"] {
  background: #ff5d8f;
  background-image: none;
}
[data-theme="pop"] .ui-switch-thumb {
  height: 16px;
  width: 16px;
  translate: 2px 0;
  background: #ffffff;
  border: 2px solid #26221c;
  box-shadow: none;
}
[data-theme="pop"] .ui-switch-thumb[data-state="checked"] {
  translate: 18px 0;
}

/* --- Cards, chips, tags ------------------------------------------------------ */
[data-theme="pop"] .ui-card {
  border: 2px solid #26221c;
  border-radius: 14px;
  box-shadow: 5px 5px 0 rgba(38, 34, 28, 0.12);
  transition:
    transform 150ms cubic-bezier(0.34, 1.56, 0.64, 1),
    box-shadow 150ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
[data-theme="pop"] .ui-card:hover {
  transform: translate(-2px, -2px);
  box-shadow: 7px 7px 0 rgba(38, 34, 28, 0.16);
}
[data-theme="pop"] .ui-chip,
[data-theme="pop"] .ui-tag {
  border: 2px solid #26221c;
  border-radius: 999px;
  font-weight: 600;
  transform: rotate(-1deg);
}

/* Thick marker-stroke icons. */
[data-theme="pop"] .lucide {
  stroke-width: 2;
}

/* --- Scrollbars -------------------------------------------------------------- */
[data-theme="pop"] *::-webkit-scrollbar-thumb {
  background: #ff5d8f;
  border: 3px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
}
[data-theme="pop"] *::-webkit-scrollbar-thumb:hover {
  background: #4d96ff;
  border: 3px solid transparent;
  background-clip: padding-box;
}

/* --- Titlebar -------------------------------------------------------------------
 * Cream bar ruled with an ink line; the logo is a tilted pink sticker with
 * a white star; the wordmark gets a wavy bubblegum underline. */
[data-theme="pop"] .titlebar-root {
  background: #fff3df;
  border-bottom: 2px solid #26221c;
}
[data-theme="pop"] .titlebar-logo {
  border-radius: 8px;
  border: 2px solid #26221c;
  background: #ff5d8f;
  box-shadow: 2px 2px 0 #26221c;
  transform: rotate(-6deg);
}
[data-theme="pop"] .titlebar-logo svg {
  display: none;
}
[data-theme="pop"] .titlebar-logo::after {
  content: "★";
  color: #ffffff;
  font-size: 12px;
  line-height: 1;
}
[data-theme="pop"] .titlebar-name {
  color: #26221c;
  font-weight: 800;
  letter-spacing: 0.02em;
  text-decoration: underline wavy #ff5d8f 2px;
  text-underline-offset: 4px;
}
[data-theme="pop"] .titlebar-tagline {
  color: #8d8474;
}
[data-theme="pop"] .titlebar-controls [data-window] {
  border-radius: 8px;
  transition: background-color 120ms ease, transform 130ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
[data-theme="pop"] .titlebar-controls [data-window]:hover {
  background: #ffd23f;
  transform: scale(1.12);
}
[data-theme="pop"] .titlebar-controls [data-window="close"]:hover {
  background: #ff5d8f;
  color: #ffffff;
}

/* --- Sidebar & session list ------------------------------------------------------
 * Deeper cream; the active destination is a yellow sticker with an ink
 * frame, and a tilted POP! badge signs the bottom of the rail. */
[data-theme="pop"] .sidebar-rail,
[data-theme="pop"] .session-list-panel {
  background: #fbeed6;
  border-right: 2px solid #26221c;
}
[data-theme="pop"] .sidebar-rail::after {
  content: "POP!";
  position: absolute;
  bottom: 76px;
  left: 50%;
  transform: translateX(-50%) rotate(-8deg);
  padding: 3px 7px;
  border: 2px solid #26221c;
  border-radius: 8px;
  background: #ffc531;
  box-shadow: 2px 2px 0 #26221c;
  color: #26221c;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.08em;
  pointer-events: none;
}
[data-theme="pop"] .sidebar-rail a[data-nav] {
  border-radius: 10px;
  border: 2px solid transparent;
  transition:
    transform 140ms cubic-bezier(0.34, 1.56, 0.64, 1),
    background-color 120ms ease,
    border-color 120ms ease,
    box-shadow 140ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
[data-theme="pop"] .sidebar-rail a[data-nav] .lucide {
  color: #8d8474;
  transition: color 120ms ease;
}
[data-theme="pop"] .sidebar-rail a[data-nav]:hover {
  transform: scale(1.08) rotate(-3deg);
}
[data-theme="pop"] .sidebar-rail a[data-nav]:hover .lucide {
  color: #26221c;
}
[data-theme="pop"] .sidebar-rail a[aria-current="page"] {
  background: #ffd23f;
  border-color: #26221c;
  box-shadow: 2px 2px 0 #26221c;
}
[data-theme="pop"] .sidebar-rail a[aria-current="page"] .lucide {
  color: #26221c;
}
[data-theme="pop"] .sidebar-rail a > span:not(.sr-only) {
  border: 2px solid #26221c;
  border-radius: 8px;
  background: #4d96ff;
  box-shadow: 2px 2px 0 #26221c;
}
[data-theme="pop"] .session-list-panel [aria-current="page"] {
  background: #fffdf6;
  border-radius: 10px;
  box-shadow: inset 3px 0 0 #ff5d8f;
}

/* --- Segmented controls & tabs ---------------------------------------------------
 * Candy track; the active segment is a pink lozenge. */
[data-theme="pop"] .mode-switch,
[data-theme="pop"] .ui-tabs {
  border: 2px solid #26221c;
  border-radius: 12px;
  background: #fffdf6;
  box-shadow: 2px 2px 0 rgba(38, 34, 28, 0.15);
}
[data-theme="pop"] .mode-switch [role="tab"] {
  border-radius: 8px;
  color: #8d8474;
  font-weight: 600;
}
[data-theme="pop"] .mode-switch [role="tab"] > span[aria-hidden] {
  border-radius: 8px;
  background: #ff5d8f;
  box-shadow: none;
}
[data-theme="pop"] .mode-switch [role="tab"][aria-selected="true"] {
  color: #ffffff;
}
[data-theme="pop"] .ui-tabs [data-state="active"],
[data-theme="pop"] .ui-tabs [aria-selected="true"] {
  border-radius: 8px;
  background: #ffe3ec;
  color: #26221c;
  box-shadow: none;
}

/* --- Chat bubble ---------------------------------------------------------------------
 * The user speaks in a sky-blue speech sticker. */
[data-theme="pop"] .chat-bubble-user {
  border: 2px solid #26221c;
  border-radius: 14px;
  border-top-right-radius: 4px;
  background: #4d96ff;
  color: #ffffff;
  box-shadow: 3px 3px 0 #26221c;
}
[data-theme="pop"] .chat-bubble-user * {
  color: #ffffff;
}

/* --- Composer ------------------------------------------------------------------------- */
[data-theme="pop"] .composer {
  background: #fff3df;
  border-top: 2px solid #26221c;
}
[data-theme="pop"] .composer-box {
  border: 2px solid #26221c;
  border-radius: 12px;
  background: #ffffff;
  box-shadow: 3px 3px 0 rgba(38, 34, 28, 0.15);
  transition: box-shadow 130ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
[data-theme="pop"] .composer-box:focus-within {
  border-color: #26221c;
  box-shadow: 4px 4px 0 #ff5d8f;
}
[data-theme="pop"] .composer-queue {
  border: 2px solid #26221c;
  border-radius: 8px;
  background: #fffdf6;
  color: #26221c;
  box-shadow: 2px 2px 0 #26221c;
  font-size: 12px;
  font-weight: 600;
  transition:
    transform 130ms cubic-bezier(0.34, 1.56, 0.64, 1),
    box-shadow 130ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
[data-theme="pop"] .composer-queue:hover {
  transform: translate(-1px, -1px);
  box-shadow: 3px 3px 0 #26221c;
  color: #26221c;
}
[data-theme="pop"] .composer-attach {
  border-radius: 8px;
}
[data-theme="pop"] .composer-steer,
[data-theme="pop"] .composer-send {
  border: 2px solid #26221c;
  border-radius: 8px;
  background: #ff5d8f;
  color: #ffffff;
  font-weight: 700;
  box-shadow: 2px 2px 0 #26221c;
  transition:
    transform 130ms cubic-bezier(0.34, 1.56, 0.64, 1),
    box-shadow 130ms cubic-bezier(0.34, 1.56, 0.64, 1),
    background-color 120ms ease;
}
[data-theme="pop"] .composer-steer:hover,
[data-theme="pop"] .composer-send:hover {
  transform: translate(-1px, -1px);
  box-shadow: 3px 3px 0 #26221c;
  background: #ff6f9d;
}
[data-theme="pop"] .composer-stop {
  border: 2px solid #26221c;
  border-radius: 8px;
  background: #ffe4e5;
  color: #e5484d;
  box-shadow: 2px 2px 0 #26221c;
}

/* --- Running activity -------------------------------------------------------
 * No neon conic ring here — a working card is a sticker that rocks in
 * place while its hard shadow cycles the candy trio. */
[data-theme="pop"] .run-border::before {
  display: none;
}
[data-theme="pop"] .run-border {
  border: 2px solid #26221c;
  border-radius: 14px;
  background: #fffdf6;
  box-shadow: 4px 4px 0 rgba(38, 34, 28, 0.15);
}
[data-theme="pop"] .run-border-active {
  border-color: #26221c;
  animation:
    pop-card-rock 1.8s ease-in-out infinite,
    pop-shadow-cycle 2.4s linear infinite;
}
@keyframes pop-card-rock {
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(0.5deg); }
  75% { transform: rotate(-0.5deg); }
}
@keyframes pop-shadow-cycle {
  0% { box-shadow: 4px 4px 0 #ff5d8f; }
  33% { box-shadow: 4px 4px 0 #ffc531; }
  66% { box-shadow: 4px 4px 0 #4d96ff; }
  100% { box-shadow: 4px 4px 0 #ff5d8f; }
}
/* Live-run orb: a bouncing candy gum-ball, not a spinning energy disc. */
[data-theme="pop"] .run-orb-glow {
  display: none;
}
[data-theme="pop"] .run-orb {
  background: #ff5d8f;
  border: 2px solid #26221c;
  animation:
    pop-orb-bounce 1.1s cubic-bezier(0.34, 1.56, 0.64, 1) infinite,
    pop-orb-cycle 2.4s linear infinite;
}
@keyframes pop-orb-bounce {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.16); }
}
@keyframes pop-orb-cycle {
  0% { background: #ff5d8f; }
  33% { background: #ffc531; }
  66% { background: #4d96ff; }
  100% { background: #ff5d8f; }
}
/* Elapsed-time chip: a yellow price-tag sticker. */
[data-theme="pop"] .run-elapsed {
  border: 2px solid #26221c;
  border-radius: 999px;
  background: #ffd23f;
  color: #26221c;
  box-shadow: 2px 2px 0 #26221c;
  font-weight: 700;
}

/* --- Overlays: tooltip, dialog, select, toast ------------------------------------------- */
[data-theme="pop"] .ui-tooltip {
  border: none;
  border-radius: 8px;
  background: #26221c;
  color: #fcf1dd;
  box-shadow: 3px 3px 0 rgba(38, 34, 28, 0.25);
  font-weight: 600;
}
[data-theme="pop"] .ui-dialog {
  border: 2px solid #26221c;
  border-radius: 16px;
  background: #fffdf6;
  box-shadow: 8px 8px 0 rgba(38, 34, 28, 0.85);
}
[data-theme="pop"] .ui-select {
  border: 2px solid #26221c;
  border-radius: 10px;
  background: #ffffff;
  box-shadow: 2px 2px 0 rgba(38, 34, 28, 0.15);
  font-size: 13px;
}
[data-theme="pop"] .ui-select-content {
  border: 2px solid #26221c;
  border-radius: 12px;
  background: #fffdf6;
  box-shadow: 5px 5px 0 rgba(38, 34, 28, 0.85);
}
[data-theme="pop"] .ui-select-content [data-highlighted] {
  border-radius: 8px;
  background: #ffe3ec;
  color: #26221c;
}
[data-theme="pop"] .ui-select-content [data-highlighted] .select-hint {
  color: #8d8474;
}
[data-theme="pop"] .ui-toast {
  border: 2px solid #26221c;
  border-radius: 12px;
  background: #fffdf6;
  box-shadow:
    inset 4px 0 0 #ffc531,
    4px 4px 0 rgba(38, 34, 28, 0.85);
}

/* Let the confetti and waves show through the chat canvas. */
[data-theme="pop"] .energy-field {
  background: transparent;
}
[data-theme="pop"] .energy-field::before {
  opacity: 0;
}

/* --- Motion -------------------------------------------------------------------------------
 * Springs everywhere, reduced to calm when the OS asks for it. */
[data-theme="pop"] .session-list-panel [aria-current="page"],
[data-theme="pop"] .mode-switch [role="tab"],
[data-theme="pop"] .ui-tabs [role="tab"] {
  transition: color 130ms ease, background-color 130ms ease;
}
@media (prefers-reduced-motion: reduce) {
  [data-theme="pop"] .ui-button,
  [data-theme="pop"] .ui-card,
  [data-theme="pop"] .sidebar-rail a[data-nav],
  [data-theme="pop"] .composer-queue,
  [data-theme="pop"] .composer-steer,
  [data-theme="pop"] .composer-send,
  [data-theme="pop"] .titlebar-controls [data-window] {
    transition: none;
    transform: none;
  }
  [data-theme="pop"] .run-border-active {
    animation: none;
    box-shadow: 4px 4px 0 #ff5d8f;
  }
  [data-theme="pop"] .run-orb {
    animation: none;
    background: #ff5d8f;
  }
}`,
  preview: {
    bg: "#fff8ea",
    line: "rgba(255, 93, 143, 0.8)",
    faint: "rgba(255, 197, 49, 0.5)",
    dots: ["#ff5d8f", "#ffc531", "#4d96ff"]
  },
  // Rounded, toy-like glyphs: robot agents, rocket runs, heart bubbles.
  icons: {
    projects: Folder,
    agents: Bot,
    teams: UsersRound,
    tasks: ListChecks,
    sessions: MessageCircleHeart,
    runs: Rocket,
    settings: Cog,
    "composer.steer": Send,
    "composer.queue": Clock
  }
};

/**
 * Sakura Sky (樱空) — the anime showpiece.
 *
 * Design language: a shinkai-style twilight sky pours down the canvas —
 * indigo zenith melting through violet into a peach horizon, fluffy cloud
 * banks stacked along the bottom, a comet streaking past a glowing moon,
 * and sakura petals ACTUALLY FALLING (the petal background layer scrolls
 * one tile per loop, seamlessly). The chrome is frosted glass: pill
 * buttons, glowing sakura-pink accents, big soft radii, rounded type.
 */
const sakura: ThemeDefinition = {
  id: "sakura",
  base: "dark",
  name: { "zh-CN": "樱空", "en-US": "Sakura Sky" },
  tokens: {
    "--canvas": "#101129",
    "--panel": "rgba(48, 36, 82, 0.5)",
    "--card": "rgba(36, 38, 78, 0.5)",
    "--card-hover": "rgba(48, 50, 96, 0.55)",
    "--line": "rgba(174, 186, 255, 0.14)",
    "--line-strong": "rgba(174, 186, 255, 0.28)",
    "--ink": "#eef0ff",
    "--ink-2": "#b9bde8",
    "--ink-3": "#7f84b8",
    "--accent": "#ff7eb0",
    "--accent-2": "#8ab4ff",
    "--accent-soft": "rgba(255, 126, 176, 0.14)",
    "--on-accent": "#471128",
    "--ok": "#6ee7b7",
    "--warn": "#fcd34d",
    "--danger": "#ff6b81",
    "--info": "#8ab4ff",
    "--aurora-1": "rgba(255, 126, 176, 0.16)",
    "--aurora-2": "rgba(138, 180, 255, 0.13)",
    "--grid-line": "transparent",
    "--shadow-card-value":
      "0 1px 2px rgba(8, 8, 26, 0.4), 0 14px 36px -16px rgba(8, 8, 26, 0.65)",
    "--shadow-pop-value":
      "0 4px 16px rgba(8, 8, 26, 0.5), 0 32px 80px -18px rgba(8, 8, 26, 0.8)",
    "--shadow-glow-value":
      "0 0 0 1px rgba(255, 126, 176, 0.45), 0 8px 36px -8px rgba(255, 126, 176, 0.55)"
  },
  // Big, soft, moe geometry — pills and clouds, nothing sharp.
  radii: {
    "--radius-sm": "10px",
    "--radius-md": "12px",
    "--radius-lg": "14px",
    "--radius-xl": "18px",
    "--radius-2xl": "22px"
  },
  bodyFont:
    'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Nunito", "Hiragino Maru Gothic ProN", "Yuanti SC", "YouYuan", "Microsoft YaHei", sans-serif',
  canvasBackground: {
    images: [
      // Moon glow high on the right.
      "radial-gradient(circle 150px at 82% 16%, rgba(255, 240, 214, 0.5) 0%, rgba(255, 240, 214, 0.12) 45%, transparent 70%)",
      // Star field with cross sparkles.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'220\' height=\'220\' viewBox=\'0 0 220 220\'%3E%3Cg fill=\'%23ffffff\'%3E%3Ccircle cx=\'24\' cy=\'30\' r=\'1.4\' opacity=\'0.8\'/%3E%3Ccircle cx=\'88\' cy=\'16\' r=\'1\' opacity=\'0.5\'/%3E%3Ccircle cx=\'150\' cy=\'44\' r=\'1.6\' opacity=\'0.7\'/%3E%3Ccircle cx=\'196\' cy=\'22\' r=\'1\' opacity=\'0.45\'/%3E%3Ccircle cx=\'58\' cy=\'84\' r=\'1\' opacity=\'0.4\'/%3E%3Ccircle cx=\'120\' cy=\'66\' r=\'1.2\' opacity=\'0.6\'/%3E%3Ccircle cx=\'182\' cy=\'96\' r=\'1\' opacity=\'0.5\'/%3E%3Ccircle cx=\'36\' cy=\'140\' r=\'1.3\' opacity=\'0.55\'/%3E%3Ccircle cx=\'96\' cy=\'120\' r=\'1\' opacity=\'0.35\'/%3E%3Ccircle cx=\'160\' cy=\'150\' r=\'1.4\' opacity=\'0.6\'/%3E%3Ccircle cx=\'210\' cy=\'180\' r=\'1\' opacity=\'0.4\'/%3E%3Ccircle cx=\'70\' cy=\'190\' r=\'1.1\' opacity=\'0.5\'/%3E%3Ccircle cx=\'130\' cy=\'205\' r=\'1\' opacity=\'0.35\'/%3E%3C/g%3E%3Cg stroke=\'%23ffffff\' stroke-linecap=\'round\'%3E%3Cpath d=\'M40 60 v8 M36 64 h8\' stroke-opacity=\'0.5\' stroke-width=\'1.2\'/%3E%3Cpath d=\'M180 130 v10 M175 135 h10\' stroke-opacity=\'0.45\' stroke-width=\'1.2\'/%3E%3C/g%3E%3C/svg%3E")',
      // A comet streaking across the upper-left sky.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'280\' height=\'130\' viewBox=\'0 0 280 130\'%3E%3Cg transform=\'rotate(-18 140 65)\'%3E%3Crect x=\'40\' y=\'58\' width=\'170\' height=\'3.5\' rx=\'1.75\' fill=\'%23ffffff\' fill-opacity=\'0.4\'/%3E%3Crect x=\'70\' y=\'67\' width=\'110\' height=\'2\' rx=\'1\' fill=\'%23ffd9e8\' fill-opacity=\'0.28\'/%3E%3Ccircle cx=\'214\' cy=\'59\' r=\'4.5\' fill=\'%23ffffff\' fill-opacity=\'0.9\'/%3E%3Ccircle cx=\'214\' cy=\'59\' r=\'8\' fill=\'%23ffffff\' fill-opacity=\'0.18\'/%3E%3C/g%3E%3C/svg%3E")',
      // Near cloud bank, moonlit white.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'340\' height=\'170\' viewBox=\'0 0 340 170\'%3E%3Cg fill=\'%23ffffff\' fill-opacity=\'0.14\'%3E%3Cellipse cx=\'80\' cy=\'142\' rx=\'70\' ry=\'28\'/%3E%3Cellipse cx=\'150\' cy=\'122\' rx=\'60\' ry=\'30\'/%3E%3Cellipse cx=\'230\' cy=\'144\' rx=\'80\' ry=\'26\'/%3E%3Cellipse cx=\'310\' cy=\'152\' rx=\'60\' ry=\'20\'/%3E%3C/g%3E%3C/svg%3E")',
      // Far cloud bank, sunset pink.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'300\' height=\'130\' viewBox=\'0 0 300 130\'%3E%3Cg fill=\'%23ffb3c8\' fill-opacity=\'0.12\'%3E%3Cellipse cx=\'60\' cy=\'108\' rx=\'56\' ry=\'20\'/%3E%3Cellipse cx=\'140\' cy=\'92\' rx=\'64\' ry=\'24\'/%3E%3Cellipse cx=\'230\' cy=\'110\' rx=\'70\' ry=\'18\'/%3E%3C/g%3E%3C/svg%3E")',
      // Sakura petals — this layer scrolls downward in a seamless loop.
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'240\' height=\'240\' viewBox=\'0 0 240 240\'%3E%3Cg%3E%3Cellipse cx=\'34\' cy=\'42\' rx=\'6\' ry=\'3.5\' transform=\'rotate(25 34 42)\' fill=\'%23ff9ec4\' fill-opacity=\'0.5\'/%3E%3Cellipse cx=\'96\' cy=\'80\' rx=\'5\' ry=\'3\' transform=\'rotate(-40 96 80)\' fill=\'%23ffd0e0\' fill-opacity=\'0.45\'/%3E%3Cellipse cx=\'170\' cy=\'36\' rx=\'6\' ry=\'3.5\' transform=\'rotate(60 170 36)\' fill=\'%23ff9ec4\' fill-opacity=\'0.4\'/%3E%3Cellipse cx=\'58\' cy=\'150\' rx=\'6\' ry=\'3.5\' transform=\'rotate(10 58 150)\' fill=\'%23ff8ab8\' fill-opacity=\'0.5\'/%3E%3Cellipse cx=\'140\' cy=\'180\' rx=\'5\' ry=\'3\' transform=\'rotate(-25 140 180)\' fill=\'%23ffd0e0\' fill-opacity=\'0.4\'/%3E%3Cellipse cx=\'205\' cy=\'120\' rx=\'6\' ry=\'3.5\' transform=\'rotate(45 205 120)\' fill=\'%23ff9ec4\' fill-opacity=\'0.45\'/%3E%3Cellipse cx=\'200\' cy=\'208\' rx=\'5\' ry=\'3\' transform=\'rotate(-60 200 208)\' fill=\'%23ff8ab8\' fill-opacity=\'0.35\'/%3E%3C/g%3E%3C/svg%3E")',
      // The twilight sky itself: indigo zenith melting into a dusty-rose
      // horizon — warm, but quiet enough to sit behind dark violet chrome.
      "linear-gradient(180deg, #0f1028 0%, #1d1f4e 30%, #39336c 52%, #6e4a88 70%, #b06592 86%, #e58b9b 100%)"
    ],
    sizes: "auto, 220px 220px, 280px 130px, auto 170px, auto 130px, 240px 240px, auto",
    repeats: "repeat, repeat, no-repeat, repeat-x, repeat-x, repeat, repeat",
    positions: "0% 0%, 0% 0%, 10% 12%, 50% 100%, 50% calc(100% - 30px), 0% 0%, 0% 0%"
  },
  css: `/* --- The sky engine ----------------------------------------------------------
 * Petals fall one tile per loop while both cloud banks drift sideways one
 * tile per loop — every layer is pinned verbatim each frame, so the loops
 * are seamless and the sky itself never moves. */
[data-theme="sakura"] body {
  animation: sakura-sky-drift 22s linear infinite;
}
@keyframes sakura-sky-drift {
  from {
    background-position:
      0% 0%, 0% 0%, 10% 12%, 0% 100%, 0% calc(100% - 30px), 0% -240px, 0% 0%;
  }
  to {
    background-position:
      0% 0%, 0% 0%, 10% 12%, 340px 100%, 300px calc(100% - 30px), 0% 0%, 0% 0%;
  }
}

/* --- Foundation ------------------------------------------------------------- */
[data-theme="sakura"] ::selection {
  background: rgba(255, 126, 176, 0.55);
  color: #ffffff;
}
[data-theme="sakura"] body {
  caret-color: #ff7eb0;
}
[data-theme="sakura"] :focus-visible {
  outline: 2px solid rgba(255, 126, 176, 0.65);
  outline-offset: 2px;
}
/* Text inputs flash their own glow on focus — no second outline inside. */
[data-theme="sakura"] textarea:focus-visible,
[data-theme="sakura"] input:focus-visible,
[data-theme="sakura"] [contenteditable]:focus-visible {
  outline: none;
}

/* Sub-agent avatars: sakura glass chip instead of the violet gradient. */
[data-theme="sakura"] .agent-avatar {
  border-color: rgba(255, 126, 176, 0.3);
  background: rgba(255, 126, 176, 0.16);
  color: #ff9ec4;
}

/* --- Buttons: frosted-glass pills -------------------------------------------- */
[data-theme="sakura"] .ui-button {
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  color: #d9ddf5;
  box-shadow: none;
  font-size: 13px;
  font-weight: 600;
  transition: transform 160ms ease, box-shadow 160ms ease, background-color 140ms ease, filter 140ms ease;
}
[data-theme="sakura"] .ui-button:hover {
  background: rgba(255, 255, 255, 0.14);
  transform: translateY(-1px);
  filter: none;
  box-shadow: 0 6px 18px -8px rgba(255, 126, 176, 0.5);
}
[data-theme="sakura"] .ui-button:active {
  transform: translateY(0);
}
[data-theme="sakura"] .ui-button-primary {
  border-color: transparent;
  background: linear-gradient(135deg, #ff8fb8, #ff6b9d);
  color: #ffffff;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.35),
    0 6px 20px -6px rgba(255, 107, 157, 0.6);
}
[data-theme="sakura"] .ui-button-primary:hover {
  background: linear-gradient(135deg, #ffa2c4, #ff7dab);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.35),
    0 8px 26px -6px rgba(255, 107, 157, 0.75);
}
[data-theme="sakura"] .ui-button-ghost {
  border-color: transparent;
  background: transparent;
}
[data-theme="sakura"] .ui-button-ghost:hover {
  background: rgba(255, 126, 176, 0.12);
  box-shadow: none;
}
[data-theme="sakura"] .ui-button-subtle {
  border-color: transparent;
  background: rgba(138, 180, 255, 0.16);
  color: #a9c6ff;
}
[data-theme="sakura"] .ui-button-subtle:hover {
  background: rgba(138, 180, 255, 0.24);
}
[data-theme="sakura"] .ui-button-danger {
  border-color: rgba(255, 107, 129, 0.4);
  color: #ff8fa0;
}
[data-theme="sakura"] .ui-button-danger:hover {
  background: rgba(255, 107, 129, 0.12);
}

/* --- Fields: glass -------------------------------------------------------------- */
[data-theme="sakura"] .ui-field {
  border-radius: 12px;
  border-color: rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  box-shadow: none;
  font-size: 13px;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
[data-theme="sakura"] .ui-field::placeholder {
  color: #6d72a5;
}
[data-theme="sakura"] .ui-field:hover {
  border-color: rgba(255, 255, 255, 0.26);
}
[data-theme="sakura"] .ui-field:focus {
  border-color: #ff7eb0;
  box-shadow:
    0 0 0 3px rgba(255, 126, 176, 0.18),
    0 0 20px -4px rgba(255, 126, 176, 0.45);
}

/* --- Toggle: glass track, sakura fill -------------------------------------------- */
[data-theme="sakura"] .ui-switch {
  height: 24px;
  width: 42px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.08);
}
[data-theme="sakura"] .ui-switch[data-state="checked"] {
  border-color: transparent;
  background: linear-gradient(135deg, #ff8fb8, #ff6b9d);
}
[data-theme="sakura"] .ui-switch-thumb {
  height: 18px;
  width: 18px;
  translate: 2px 0;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(8, 8, 26, 0.5);
}
[data-theme="sakura"] .ui-switch-thumb[data-state="checked"] {
  translate: 19px 0;
}

/* --- Cards & chips: frosted panes floating over the sky ----------------------------- */
[data-theme="sakura"] .ui-card {
  border-radius: 18px;
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.05);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
  box-shadow: 0 14px 36px -18px rgba(8, 8, 26, 0.7);
  transition: border-color 160ms ease, box-shadow 160ms ease, transform 180ms ease;
}
[data-theme="sakura"] .ui-card:hover {
  border-color: rgba(255, 126, 176, 0.35);
  transform: translateY(-2px);
  box-shadow:
    0 18px 44px -18px rgba(8, 8, 26, 0.75),
    0 0 24px -10px rgba(255, 126, 176, 0.35);
}
[data-theme="sakura"] .ui-chip,
[data-theme="sakura"] .ui-tag {
  border-radius: 999px;
}
[data-theme="sakura"] .lucide {
  stroke-width: 1.75;
}

/* --- Scrollbars ------------------------------------------------------------------------ */
[data-theme="sakura"] *::-webkit-scrollbar-thumb {
  background: rgba(255, 126, 176, 0.4);
  border: 3px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
}
[data-theme="sakura"] *::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 126, 176, 0.6);
  border: 3px solid transparent;
  background-clip: padding-box;
}

/* --- Titlebar ----------------------------------------------------------------------------- */
[data-theme="sakura"] .titlebar-root {
  background: rgba(40, 30, 72, 0.4);
  border-bottom-color: rgba(255, 255, 255, 0.1);
}
[data-theme="sakura"] .titlebar-logo {
  border-radius: 999px;
  background: linear-gradient(135deg, #ff8fb8, #ff6b9d);
  box-shadow: 0 0 14px rgba(255, 126, 176, 0.55);
}
[data-theme="sakura"] .titlebar-logo svg {
  display: none;
}
[data-theme="sakura"] .titlebar-logo::after {
  content: "桜";
  color: #ffffff;
  font-size: 12px;
  line-height: 1;
}
[data-theme="sakura"] .titlebar-name {
  background: linear-gradient(90deg, #ff9ec4, #c9b8ff 40%, #8ab4ff 60%, #ff9ec4);
  background-size: 220% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
  font-weight: 800;
  letter-spacing: 0.06em;
  animation: sakura-name-shine 8s linear infinite;
}
@keyframes sakura-name-shine {
  0% { background-position: 0% 0; }
  100% { background-position: 220% 0; }
}
[data-theme="sakura"] .titlebar-tagline {
  color: #9aa0cf;
}
[data-theme="sakura"] .titlebar-controls [data-window] {
  border-radius: 999px;
  transition: background-color 140ms ease, transform 160ms ease;
}
[data-theme="sakura"] .titlebar-controls [data-window]:hover {
  background: rgba(255, 255, 255, 0.14);
  transform: scale(1.1);
}
[data-theme="sakura"] .titlebar-controls [data-window="close"]:hover {
  background: rgba(255, 107, 157, 0.85);
  color: #ffffff;
}

/* --- Sidebar & session list: glass rail over the clouds ------------------------------------- */
[data-theme="sakura"] .sidebar-rail,
[data-theme="sakura"] .session-list-panel {
  background: rgba(38, 28, 68, 0.38);
  border-right-color: rgba(255, 255, 255, 0.08);
}
[data-theme="sakura"] .sidebar-rail::after {
  content: "桜空";
  position: absolute;
  bottom: 72px;
  left: 50%;
  transform: translateX(-50%);
  writing-mode: vertical-rl;
  font-size: 14px;
  letter-spacing: 10px;
  color: rgba(255, 158, 196, 0.45);
  pointer-events: none;
}
[data-theme="sakura"] .sidebar-rail a[data-nav] {
  border-radius: 999px;
  transition: transform 160ms ease, background-color 140ms ease, box-shadow 160ms ease;
}
[data-theme="sakura"] .sidebar-rail a[data-nav] .lucide {
  color: #7f84b8;
  transition: color 140ms ease;
}
[data-theme="sakura"] .sidebar-rail a[data-nav]:hover {
  background: rgba(255, 255, 255, 0.08);
  transform: scale(1.1);
}
[data-theme="sakura"] .sidebar-rail a[data-nav]:hover .lucide {
  color: #ff9ec4;
}
[data-theme="sakura"] .sidebar-rail a[aria-current="page"] {
  background: linear-gradient(135deg, #ff8fb8, #ff6b9d);
  box-shadow: 0 4px 16px -4px rgba(255, 107, 157, 0.7);
}
[data-theme="sakura"] .sidebar-rail a[aria-current="page"] .lucide {
  color: #ffffff;
}
[data-theme="sakura"] .sidebar-rail a > span:not(.sr-only) {
  border-radius: 999px;
  background: linear-gradient(135deg, #ff8fb8, #ff6b9d);
  box-shadow: 0 0 12px rgba(255, 126, 176, 0.5);
}
[data-theme="sakura"] .session-list-panel [aria-current="page"] {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  box-shadow: inset 3px 0 0 #ff7eb0;
}

/* --- Segmented controls & tabs --------------------------------------------------------------- */
[data-theme="sakura"] .mode-switch,
[data-theme="sakura"] .ui-tabs {
  border-radius: 999px;
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(16, 17, 40, 0.45);
  box-shadow: none;
}
[data-theme="sakura"] .mode-switch [role="tab"] {
  border-radius: 999px;
  color: #8f94c4;
  font-weight: 600;
}
[data-theme="sakura"] .mode-switch [role="tab"] > span[aria-hidden] {
  border-radius: 999px;
  background: linear-gradient(135deg, #ff8fb8, #ff6b9d);
  box-shadow: 0 3px 12px -3px rgba(255, 107, 157, 0.7);
}
[data-theme="sakura"] .mode-switch [role="tab"][aria-selected="true"] {
  color: #ffffff;
}
[data-theme="sakura"] .ui-tabs [data-state="active"],
[data-theme="sakura"] .ui-tabs [aria-selected="true"] {
  border-radius: 999px;
  background: rgba(255, 126, 176, 0.18);
  color: #ffb9d3;
  box-shadow: none;
}

/* --- Chat bubble: a sakura cloud --------------------------------------------------------------- */
[data-theme="sakura"] .chat-bubble-user {
  border-radius: 18px;
  border-top-right-radius: 6px;
  border-color: transparent;
  background: linear-gradient(135deg, #ff8fb8, #f0629c);
  color: #ffffff;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.3),
    0 8px 24px -8px rgba(240, 98, 156, 0.6);
}
[data-theme="sakura"] .chat-bubble-user * {
  color: #ffffff;
}

/* --- Composer ----------------------------------------------------------------------------------- */
[data-theme="sakura"] .composer {
  background: rgba(44, 32, 76, 0.45);
  border-top-color: rgba(255, 255, 255, 0.1);
}
[data-theme="sakura"] .composer-box {
  border-radius: 16px;
  border-color: rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  box-shadow: none;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
[data-theme="sakura"] .composer-box:focus-within {
  border-color: #ff7eb0;
  box-shadow:
    0 0 0 3px rgba(255, 126, 176, 0.16),
    0 0 24px -6px rgba(255, 126, 176, 0.5);
}
[data-theme="sakura"] .composer-queue {
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.06);
  color: #d9ddf5;
  box-shadow: none;
  font-size: 12px;
  font-weight: 600;
}
[data-theme="sakura"] .composer-queue:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #ffffff;
}
[data-theme="sakura"] .composer-attach {
  border-radius: 999px;
}
[data-theme="sakura"] .composer-steer,
[data-theme="sakura"] .composer-send {
  border-radius: 999px;
  border: none;
  background: linear-gradient(135deg, #ff8fb8, #ff6b9d);
  color: #ffffff;
  font-weight: 700;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.3),
    0 4px 16px -4px rgba(255, 107, 157, 0.65);
  transition: transform 160ms ease, box-shadow 160ms ease, filter 140ms ease;
}
[data-theme="sakura"] .composer-steer:hover,
[data-theme="sakura"] .composer-send:hover {
  transform: translateY(-1px);
  filter: brightness(1.08);
}
[data-theme="sakura"] .composer-stop {
  border-radius: 999px;
  border: 1px solid rgba(255, 107, 129, 0.45);
  background: rgba(255, 107, 129, 0.14);
  color: #ff8fa0;
  box-shadow: none;
}

/* --- Running activity ----------------------------------------------------------
 * The live steps card is a frosted pane with a breathing sakura glow; the
 * conic ring stays — pink/blue kirakira is native to this theme. */
[data-theme="sakura"] .run-border {
  border-radius: 18px;
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.05);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
}
[data-theme="sakura"] .run-border-active {
  border-color: rgba(255, 126, 176, 0.3);
  animation: sakura-run-breathe 2.6s ease-in-out infinite;
}
@keyframes sakura-run-breathe {
  0%, 100% { box-shadow: 0 0 18px -6px rgba(255, 126, 176, 0.35); }
  50% { box-shadow: 0 0 34px -4px rgba(255, 126, 176, 0.65); }
}
/* The spinning orb gets a pink halo to read against the sky. */
[data-theme="sakura"] .run-orb {
  filter: drop-shadow(0 0 5px rgba(255, 126, 176, 0.65));
}
/* Elapsed-time chip: a sakura glass pill. */
[data-theme="sakura"] .run-elapsed {
  border: 1px solid rgba(255, 126, 176, 0.4);
  border-radius: 999px;
  background: rgba(255, 126, 176, 0.14);
  color: #ffb9d3;
  box-shadow: 0 0 14px -4px rgba(255, 126, 176, 0.45);
  font-weight: 600;
}

/* --- Overlays ------------------------------------------------------------------------------------- */
[data-theme="sakura"] .ui-tooltip {
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  background: rgba(33, 27, 60, 0.92);
  color: #d9ddf5;
  box-shadow: 0 10px 28px -10px rgba(8, 8, 26, 0.8);
}
[data-theme="sakura"] .ui-dialog {
  border-radius: 20px;
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(35, 29, 64, 0.75);
  -webkit-backdrop-filter: blur(24px) saturate(1.3);
  backdrop-filter: blur(24px) saturate(1.3);
  box-shadow: 0 32px 80px -20px rgba(8, 8, 26, 0.85);
}
[data-theme="sakura"] .ui-select {
  border-radius: 12px;
  border-color: rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  box-shadow: none;
  font-size: 13px;
}
[data-theme="sakura"] .ui-select-content {
  border-radius: 14px;
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(35, 29, 64, 0.88);
  -webkit-backdrop-filter: blur(20px);
  backdrop-filter: blur(20px);
  box-shadow: 0 18px 48px -12px rgba(8, 8, 26, 0.85);
}
[data-theme="sakura"] .ui-select-content [data-highlighted] {
  border-radius: 10px;
  background: rgba(255, 126, 176, 0.16);
  color: #ffb9d3;
}
[data-theme="sakura"] .ui-select-content [data-highlighted] .select-hint {
  color: #8f94c4;
}
[data-theme="sakura"] .ui-toast {
  border-radius: 14px;
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(35, 29, 64, 0.88);
  box-shadow:
    inset 3px 0 0 #ff7eb0,
    0 16px 40px -12px rgba(8, 8, 26, 0.85);
}

/* Frosted glass over the sky for every overlay surface: the horizon's rose
 * glow comes through, muted to a readable dusk-violet wash. */
[data-theme="sakura"] .titlebar-root,
[data-theme="sakura"] .sidebar-rail,
[data-theme="sakura"] .session-list-panel,
[data-theme="sakura"] .composer {
  -webkit-backdrop-filter: blur(28px) saturate(1.45);
  backdrop-filter: blur(28px) saturate(1.45);
}

/* The sky IS the chat canvas. */
[data-theme="sakura"] .energy-field {
  background: transparent;
}
[data-theme="sakura"] .energy-field::before {
  opacity: 0;
}

/* --- Motion ---------------------------------------------------------------------------------------- */
[data-theme="sakura"] .session-list-panel [aria-current="page"],
[data-theme="sakura"] .mode-switch [role="tab"],
[data-theme="sakura"] .ui-tabs [role="tab"] {
  transition: color 150ms ease, background-color 150ms ease;
}
@media (prefers-reduced-motion: reduce) {
  [data-theme="sakura"] body {
    animation: none;
  }
  [data-theme="sakura"] .titlebar-name,
  [data-theme="sakura"] .run-border-active {
    animation: none;
  }
  [data-theme="sakura"] .ui-button,
  [data-theme="sakura"] .ui-card,
  [data-theme="sakura"] .composer-steer,
  [data-theme="sakura"] .composer-send,
  [data-theme="sakura"] .sidebar-rail a[data-nav],
  [data-theme="sakura"] .titlebar-controls [data-window] {
    transition: none;
    transform: none;
  }
}`,
  preview: {
    bg: "#23254d",
    line: "rgba(255, 126, 176, 0.8)",
    faint: "rgba(138, 180, 255, 0.35)",
    dots: ["#ff7eb0", "#8ab4ff", "#ffd9e8"]
  },
  // Sparkly, soft glyphs for the moe rail.
  icons: {
    projects: Folder,
    agents: Bot,
    teams: UsersRound,
    tasks: Sparkles,
    sessions: MessageCircleHeart,
    runs: Rocket,
    settings: Cog,
    "composer.steer": Send,
    "composer.queue": Clock
  }
};

/**
 * Classic (经典模式) — the familiar AI-chat-client look.
 *
 * Design language: pure white canvas, light-gray sidebar, hairline
 * borders, neutral graphite primary actions, quiet segmented controls.
 * No patterns, no glows, no bouncy motion — the restraint IS the style.
 */
const classic: ThemeDefinition = {
  id: "classic",
  base: "light",
  name: { "zh-CN": "经典模式", "en-US": "Classic" },
  tokens: {
    "--canvas": "#ffffff",
    "--panel": "rgba(255, 255, 255, 0.9)",
    "--card": "#ffffff",
    "--card-hover": "#fafafa",
    "--line": "rgba(0, 0, 0, 0.08)",
    "--line-strong": "rgba(0, 0, 0, 0.14)",
    "--ink": "#1a1a1a",
    "--ink-2": "#4d4d4d",
    "--ink-3": "#999999",
    "--accent": "#2e6bf0",
    "--accent-2": "#6b9bff",
    "--accent-soft": "rgba(46, 107, 240, 0.08)",
    "--on-accent": "#ffffff",
    "--ok": "#16a34a",
    "--warn": "#d97706",
    "--danger": "#dc2626",
    "--info": "#2563eb",
    "--aurora-1": "transparent",
    "--aurora-2": "transparent",
    "--grid-line": "transparent",
    "--shadow-card-value": "0 1px 2px rgba(0, 0, 0, 0.05)",
    "--shadow-pop-value":
      "0 4px 12px rgba(0, 0, 0, 0.08), 0 16px 48px -12px rgba(0, 0, 0, 0.16)",
    "--shadow-glow-value": "0 0 0 3px rgba(46, 107, 240, 0.16)"
  },
  radii: {
    "--radius-sm": "6px",
    "--radius-md": "8px",
    "--radius-lg": "10px",
    "--radius-xl": "12px",
    "--radius-2xl": "14px"
  },
  css: `/* --- Foundation ---------------------------------------------------------- */
[data-theme="classic"] ::selection {
  background: rgba(46, 107, 240, 0.16);
}
[data-theme="classic"] :focus-visible {
  outline: 2px solid rgba(46, 107, 240, 0.5);
  outline-offset: 1px;
}
[data-theme="classic"] textarea:focus-visible,
[data-theme="classic"] input:focus-visible,
[data-theme="classic"] [contenteditable]:focus-visible {
  outline: none;
}

/* --- Buttons: quiet white, graphite primary -------------------------------- */
[data-theme="classic"] .ui-button {
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  background: #ffffff;
  color: #333333;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  font-size: 13px;
}
[data-theme="classic"] .ui-button:hover {
  background: #f5f5f5;
  filter: none;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
[data-theme="classic"] .ui-button-primary {
  border-color: transparent;
  background: #262626;
  color: #ffffff;
}
[data-theme="classic"] .ui-button-primary:hover {
  background: #3a3a3a;
}
[data-theme="classic"] .ui-button-ghost {
  border-color: transparent;
  box-shadow: none;
  background: transparent;
}
[data-theme="classic"] .ui-button-ghost:hover {
  background: rgba(0, 0, 0, 0.05);
}
[data-theme="classic"] .ui-button-subtle {
  border-color: transparent;
  background: rgba(0, 0, 0, 0.05);
  color: #333333;
}
[data-theme="classic"] .ui-button-subtle:hover {
  background: rgba(0, 0, 0, 0.08);
}
[data-theme="classic"] .ui-button-danger {
  border-color: rgba(220, 38, 38, 0.3);
  color: #dc2626;
}
[data-theme="classic"] .ui-button-danger:hover {
  background: rgba(220, 38, 38, 0.06);
}

/* --- Fields ------------------------------------------------------------------ */
[data-theme="classic"] .ui-field {
  border-radius: 8px;
  border-color: rgba(0, 0, 0, 0.12);
  background: #ffffff;
  box-shadow: none;
  font-size: 13px;
}
[data-theme="classic"] .ui-field:hover {
  border-color: rgba(0, 0, 0, 0.2);
}
[data-theme="classic"] .ui-field:focus {
  border-color: #2e6bf0;
  box-shadow: 0 0 0 3px rgba(46, 107, 240, 0.14);
}

/* --- Toggle -------------------------------------------------------------------- */
[data-theme="classic"] .ui-switch {
  height: 22px;
  width: 38px;
  border: none;
  background: rgba(0, 0, 0, 0.15);
}
[data-theme="classic"] .ui-switch[data-state="checked"] {
  background: #22c55e;
  background-image: none;
}
[data-theme="classic"] .ui-switch-thumb {
  height: 18px;
  width: 18px;
  translate: 2px 0;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}
[data-theme="classic"] .ui-switch-thumb[data-state="checked"] {
  translate: 18px 0;
}

/* --- Cards & chips ---------------------------------------------------------------- */
[data-theme="classic"] .ui-card {
  border-radius: 10px;
  border-color: rgba(0, 0, 0, 0.08);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
[data-theme="classic"] .ui-chip,
[data-theme="classic"] .ui-tag {
  border-radius: 6px;
}

/* Sub-agent avatars: neutral gray tile instead of the violet gradient. */
[data-theme="classic"] .agent-avatar {
  background: #f0f0f2;
  color: #737373;
  border-color: rgba(0, 0, 0, 0.08);
}

/* --- Scrollbars --------------------------------------------------------------------- */
[data-theme="classic"] *::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.16);
  border: 3px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
}
[data-theme="classic"] *::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.26);
  border: 3px solid transparent;
  background-clip: padding-box;
}

/* --- Titlebar -------------------------------------------------------------------------- */
[data-theme="classic"] .titlebar-root {
  background: #ffffff;
  border-bottom-color: rgba(0, 0, 0, 0.06);
}
[data-theme="classic"] .titlebar-logo {
  background: linear-gradient(135deg, #3b82f6, #8b5cf6);
  border-radius: 6px;
  box-shadow: none;
}
[data-theme="classic"] .titlebar-name {
  color: #1a1a1a;
  font-weight: 600;
}
[data-theme="classic"] .titlebar-tagline {
  color: #999999;
}
[data-theme="classic"] .titlebar-controls [data-window]:hover {
  background: rgba(0, 0, 0, 0.06);
}
[data-theme="classic"] .titlebar-controls [data-window="close"]:hover {
  background: #e8112d;
  color: #ffffff;
}

/* --- Sidebar & session list: light gray, white active row --------------------------------- */
[data-theme="classic"] .sidebar-rail,
[data-theme="classic"] .session-list-panel {
  background: #f7f7f8;
  border-right-color: rgba(0, 0, 0, 0.06);
}
[data-theme="classic"] .sidebar-rail a[data-nav] .lucide {
  color: #8a8a8a;
}
[data-theme="classic"] .sidebar-rail a[data-nav]:hover {
  background: rgba(0, 0, 0, 0.05);
}
[data-theme="classic"] .sidebar-rail a[data-nav]:hover .lucide {
  color: #1a1a1a;
}
[data-theme="classic"] .sidebar-rail a[aria-current="page"] {
  background: rgba(0, 0, 0, 0.06);
  box-shadow: none;
}
/* Each destination keeps its own hue — colored wayfinding, neutral chrome. */
[data-theme="classic"] .sidebar-rail a[data-nav="projects"] .lucide { color: #3b82f6; }
[data-theme="classic"] .sidebar-rail a[data-nav="agents"] .lucide { color: #8b5cf6; }
[data-theme="classic"] .sidebar-rail a[data-nav="teams"] .lucide { color: #10b981; }
[data-theme="classic"] .sidebar-rail a[data-nav="tasks"] .lucide { color: #f59e0b; }
[data-theme="classic"] .sidebar-rail a[data-nav="sessions"] .lucide { color: #ec4899; }
[data-theme="classic"] .sidebar-rail a[data-nav="runs"] .lucide { color: #06b6d4; }
[data-theme="classic"] .sidebar-rail a[data-nav="settings"] .lucide { color: #6b7280; }
[data-theme="classic"] .sidebar-rail a[data-nav]:hover .lucide {
  filter: brightness(0.85);
}
[data-theme="classic"] .session-list-panel [aria-current="page"] {
  background: #ffffff;
  border-radius: 8px;
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.05),
    0 1px 2px rgba(0, 0, 0, 0.05);
}

/* --- Segmented controls & tabs: gray track, white pill --------------------------------------- */
[data-theme="classic"] .mode-switch,
[data-theme="classic"] .ui-tabs {
  border-radius: 10px;
  border: none;
  background: rgba(0, 0, 0, 0.06);
  box-shadow: none;
}
[data-theme="classic"] .mode-switch [role="tab"] {
  border-radius: 8px;
  color: #737373;
}
[data-theme="classic"] .mode-switch [role="tab"] > span[aria-hidden] {
  border-radius: 8px;
  background: #ffffff;
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.04),
    0 1px 3px rgba(0, 0, 0, 0.1);
}
[data-theme="classic"] .mode-switch [role="tab"][aria-selected="true"] {
  color: #1a1a1a;
  font-weight: 600;
}
[data-theme="classic"] .ui-tabs [data-state="active"],
[data-theme="classic"] .ui-tabs [aria-selected="true"] {
  border-radius: 8px;
  background: #ffffff;
  color: #1a1a1a;
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.04),
    0 1px 3px rgba(0, 0, 0, 0.1);
}

/* --- Chat bubble: plain light-gray block -------------------------------------------------------- */
[data-theme="classic"] .chat-bubble-user {
  border-radius: 12px;
  border-color: rgba(46, 107, 240, 0.16);
  background: #f0f5ff;
  color: #1a1a1a;
  box-shadow: none;
}
[data-theme="classic"] .chat-bubble-user * {
  color: #1a1a1a;
}

/* --- Running activity: calm gray card, no neon ring ------------------------------------------------ */
[data-theme="classic"] .run-border::before {
  display: none;
}
[data-theme="classic"] .run-border {
  border-radius: 10px;
  border-color: rgba(0, 0, 0, 0.08);
  background: #ffffff;
}
[data-theme="classic"] .run-border-active {
  border-color: rgba(0, 0, 0, 0.1);
  box-shadow: none;
}
/* No pulsing halo around status dots — outer glow off, text shimmer stays. */
[data-theme="classic"] [class*="pulse-ring"] {
  display: none;
}
[data-theme="classic"] .run-elapsed {
  border-color: rgba(0, 0, 0, 0.1);
  background: rgba(0, 0, 0, 0.05);
  color: #4d4d4d;
}
[data-theme="classic"] .run-orb {
  filter: none;
}

/* --- Composer ---------------------------------------------------------------------------------------- */
[data-theme="classic"] .composer {
  background: #ffffff;
  border-top-color: rgba(0, 0, 0, 0.06);
}
[data-theme="classic"] .composer-box {
  border-radius: 12px;
  border-color: rgba(0, 0, 0, 0.12);
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}
[data-theme="classic"] .composer-box:focus-within {
  border-color: #2e6bf0;
  box-shadow: 0 0 0 3px rgba(46, 107, 240, 0.12);
}
[data-theme="classic"] .composer-queue {
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  background: #ffffff;
  color: #4d4d4d;
  box-shadow: none;
  font-size: 12px;
}
[data-theme="classic"] .composer-queue:hover {
  background: #f5f5f5;
  color: #1a1a1a;
}
[data-theme="classic"] .composer-attach {
  border-radius: 8px;
}
[data-theme="classic"] .composer-steer,
[data-theme="classic"] .composer-send {
  border-radius: 8px;
  background: #262626;
  color: #ffffff;
  box-shadow: none;
}
[data-theme="classic"] .composer-steer:hover,
[data-theme="classic"] .composer-send:hover {
  background: #3a3a3a;
}
[data-theme="classic"] .composer-stop {
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  background: #ffffff;
  color: #dc2626;
  box-shadow: none;
}

/* --- Overlays: tooltip, dialog, select, toast --------------------------------------------------------- */
[data-theme="classic"] .ui-tooltip {
  border: none;
  border-radius: 6px;
  background: rgba(23, 23, 23, 0.95);
  color: #f5f5f5;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}
[data-theme="classic"] .ui-dialog {
  border-radius: 12px;
  border-color: rgba(0, 0, 0, 0.08);
  background: #ffffff;
  box-shadow: 0 24px 64px -16px rgba(0, 0, 0, 0.25);
}
[data-theme="classic"] .ui-select {
  border-radius: 8px;
  border-color: rgba(0, 0, 0, 0.12);
  background: #ffffff;
  box-shadow: none;
  font-size: 13px;
}
[data-theme="classic"] .ui-select-content {
  border-radius: 10px;
  border-color: rgba(0, 0, 0, 0.08);
  background: #ffffff;
  box-shadow: 0 12px 36px -8px rgba(0, 0, 0, 0.18);
}
[data-theme="classic"] .ui-select-content [data-highlighted] {
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.05);
  color: #1a1a1a;
}
[data-theme="classic"] .ui-toast {
  border-radius: 10px;
  border-color: rgba(0, 0, 0, 0.08);
  background: #ffffff;
  box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.18);
}

/* Clean white chat canvas — no energy field, no patterns. */
[data-theme="classic"] .energy-field {
  background: #ffffff;
}
[data-theme="classic"] .energy-field::before {
  opacity: 0;
}

/* --- Thinking indicator: a bare gray line, no card chrome ----------------------
 * Sits at the top of the active turn; appended last so it wins over the
 * generic .run-border card styling. */
[data-theme="classic"] .run-indicator {
  border: none;
  background: transparent;
  box-shadow: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
[data-theme="classic"] .run-indicator .run-orb,
[data-theme="classic"] .run-indicator .run-orb-glow {
  display: none;
}
/* No icon at all — the whole 40px icon slot goes away. */
[data-theme="classic"] .run-indicator span:has(> .run-indicator-icon) {
  display: none;
}
/* Bare single line: no card padding, seconds sit right after the text. */
[data-theme="classic"] .run-indicator > div {
  padding: 2px 0;
}
[data-theme="classic"] .run-indicator .flex-1 {
  flex: 0 0 auto;
}
/* Live text shimmer: a soft light sweep traveling across the line —
 * on the thinking label, the elapsed seconds, and the ticking fold row.
 * Fixed 240px tile + px-position animation = constant px/s speed even as
 * the timer text changes width every second. */
[data-theme="classic"] .run-indicator .shimmer-text,
[data-theme="classic"] .run-indicator .run-elapsed,
[data-theme="classic"] .process-fold-label-live {
  background: linear-gradient(100deg, #8a8a8a 0px, #8a8a8a 96px, #ececec 120px, #8a8a8a 144px, #8a8a8a 240px);
  background-size: 240px 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
  animation: classic-text-shine 2.4s linear infinite;
}
@keyframes classic-text-shine {
  from { background-position: -240px 0; }
  to { background-position: 0 0; }
}
[data-theme="classic"] .run-indicator .run-elapsed {
  border: none;
  box-shadow: none;
}
[data-theme="classic"] .run-sublabel {
  display: none;
}
[data-theme="classic"] .run-indicator .run-elapsed > span {
  display: none;
}

/* Process fold row: quiet gray line with a hairline underneath. */
[data-theme="classic"] .process-fold-toggle {
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
}`,
  preview: {
    bg: "#ffffff",
    line: "rgba(0, 0, 0, 0.35)",
    faint: "rgba(0, 0, 0, 0.08)"
  }
};

export const BUILTIN_THEMES: ThemeDefinition[] = [dark, light, aurora, ukiyoe, macos, terminal, dusk, deco, pop, sakura, classic];

/* ------------------------------------------------------------------------- */
/* Registry operations                                                        */
/* ------------------------------------------------------------------------- */

/** Minimal structural validation for theme packs (market / user install). */
export function isValidTheme(value: unknown): value is ThemeDefinition {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<ThemeDefinition>;
  return (
    typeof t.id === "string" &&
    /^[a-z0-9-]+$/.test(t.id) &&
    (t.base === "light" || t.base === "dark") &&
    !!t.name &&
    typeof t.name["zh-CN"] === "string" &&
    typeof t.name["en-US"] === "string" &&
    !!t.tokens &&
    typeof t.tokens === "object" &&
    !!t.preview &&
    typeof t.preview.bg === "string" &&
    typeof t.preview.line === "string" &&
    typeof t.preview.faint === "string"
  );
}

/** Builtin themes overlaid with installed packs (packs may override by id). */
export function listThemes(custom: ThemeDefinition[] = []): ThemeDefinition[] {
  const byId = new Map(BUILTIN_THEMES.map((t) => [t.id, t]));
  for (const t of custom) {
    if (isValidTheme(t)) byId.set(t.id, t);
  }
  return [...byId.values()];
}

export function getTheme(
  id: string,
  custom: ThemeDefinition[] = []
): ThemeDefinition | undefined {
  return listThemes(custom).find((t) => t.id === id);
}

/* ------------------------------------------------------------------------- */
/* CSS generation                                                             */
/* ------------------------------------------------------------------------- */

/** Generates the full stylesheet for a theme, scoped by [data-theme="<id>"]. */
export function buildThemeCss(theme: ThemeDefinition): string {
  const scope = `[data-theme="${theme.id}"]`;
  const parts: string[] = [];

  const vars = Object.entries({ ...theme.radii, ...theme.tokens })
    .map(([key, value]) => `  ${key}: ${value};`)
    .join("\n");
  parts.push(`${scope} {\n  color-scheme: ${theme.base};\n${vars}\n}`);

  const bodyRules: string[] = [];
  if (theme.bodyFont) bodyRules.push(`font-family: ${theme.bodyFont}`);
  if (theme.canvasBackground) {
    bodyRules.push(`background-image: ${theme.canvasBackground.images.join(",\n    ")}`);
    if (theme.canvasBackground.sizes) {
      bodyRules.push(`background-size: ${theme.canvasBackground.sizes}`);
    }
    if (theme.canvasBackground.repeats) {
      bodyRules.push(`background-repeat: ${theme.canvasBackground.repeats}`);
    }
    if (theme.canvasBackground.positions) {
      bodyRules.push(`background-position: ${theme.canvasBackground.positions}`);
    }
  }
  if (bodyRules.length > 0) {
    parts.push(`${scope} body {\n  ${bodyRules.join(";\n  ")};\n}`);
  }

  if (theme.css) parts.push(theme.css);
  return parts.join("\n\n");
}
