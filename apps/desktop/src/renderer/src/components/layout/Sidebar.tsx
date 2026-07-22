import { motion } from "framer-motion";
import { NavLink, useLocation } from "react-router-dom";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useSettingsStore } from "../../stores/settings";
import { NAV_ENTRIES } from "./nav";

export function Sidebar(): JSX.Element {
  const { t } = useI18n();
  const location = useLocation();
  const hiddenNav = useSettingsStore((state) => state.hiddenNav);

  const entries = NAV_ENTRIES.filter((entry) => !hiddenNav.includes(entry.key));
  const primary = entries.filter((entry) => entry.key !== "settings");
  const settingsEntry = entries.find((entry) => entry.key === "settings");

  const renderLink = (entry: (typeof NAV_ENTRIES)[number]): JSX.Element => {
    const Icon = entry.icon;
    const active =
      location.pathname === entry.path || location.pathname.startsWith(`${entry.path}/`);
    return (
      <li key={entry.key}>
        <NavLink
          to={entry.path}
          aria-current={active ? "page" : undefined}
          className={cn(
            "group relative flex h-9.5 items-center gap-3 rounded-xl px-3 text-sm font-medium outline-none transition-colors duration-150",
            "focus-visible:ring-2 focus-visible:ring-accent/70",
            active ? "text-accent" : "text-ink-2 hover:bg-accent-soft/60 hover:text-ink"
          )}
        >
          {active && (
            <motion.span
              layoutId="nav-active-pill"
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
              className="absolute inset-0 rounded-xl border border-accent/25 bg-accent-soft"
              aria-hidden
            />
          )}
          <Icon
            className={cn(
              "relative z-10 h-4.5 w-4.5 transition-transform duration-150 group-hover:scale-110",
              active ? "text-accent" : "text-ink-3 group-hover:text-ink-2"
            )}
            aria-hidden
          />
          <span className="relative z-10">{t(`nav.${entry.key}` as MessageKey)}</span>
          {active && (
            <motion.span
              layoutId="nav-active-dot"
              className="relative z-10 ml-auto h-1.5 w-1.5 rounded-full bg-accent"
              aria-hidden
            />
          )}
        </NavLink>
      </li>
    );
  };

  return (
    <nav
      aria-label={t("nav.section")}
      className="relative z-20 flex w-56 shrink-0 flex-col border-r border-line bg-panel backdrop-blur-xl"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <p className="mb-2 px-3 text-[11px] font-semibold tracking-widest text-ink-3 uppercase">
          {t("nav.section")}
        </p>
        <ul className="space-y-1">{primary.map(renderLink)}</ul>
      </div>
      {settingsEntry && (
        <div className="border-t border-line px-3 py-3">
          <ul className="space-y-1">{[settingsEntry].map(renderLink)}</ul>
        </div>
      )}
    </nav>
  );
}
