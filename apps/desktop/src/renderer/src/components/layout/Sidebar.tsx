import { motion } from "framer-motion";
import { NavLink, useLocation } from "react-router-dom";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useSettingsStore } from "../../stores/settings";
import { useIconOverrides } from "../../lib/use-icon-overrides";
import { Tooltip } from "../ui/Tooltip";
import { NAV_ENTRIES } from "./nav";

export function Sidebar(): JSX.Element {
  const { t } = useI18n();
  const location = useLocation();
  const hiddenNav = useSettingsStore((state) => state.hiddenNav);
  const iconOverrides = useIconOverrides();

  const entries = NAV_ENTRIES.filter((entry) => !hiddenNav.includes(entry.key));
  const primary = entries.filter((entry) => entry.key !== "settings");
  const settingsEntry = entries.find((entry) => entry.key === "settings");

  const renderLink = (entry: (typeof NAV_ENTRIES)[number]): JSX.Element => {
    const Icon = iconOverrides?.[entry.key] ?? entry.icon;
    const label = t(`nav.${entry.key}` as MessageKey);
    const active =
      location.pathname === entry.path || location.pathname.startsWith(`${entry.path}/`);
    return (
      <li key={entry.key}>
        <Tooltip content={label} side="right">
          <NavLink
            to={entry.path}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            data-nav={entry.key}
            className={cn(
              "group relative grid h-10 w-10 place-items-center rounded-xl outline-none transition-[background-color,color,box-shadow,transform] duration-200",
              "focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-panel",
              active
                ? "bg-card text-accent shadow-[0_1px_2px_rgba(21,26,35,0.06),0_8px_24px_-14px_rgba(101,83,240,0.72),inset_0_0_0_1px_var(--line)]"
                : "text-ink-3 hover:-translate-y-px hover:bg-card/75 hover:text-ink hover:shadow-[inset_0_0_0_1px_var(--line)]"
            )}
          >
            {active && (
              <motion.span
                layoutId="nav-active-rail"
                transition={{ type: "spring", stiffness: 460, damping: 36 }}
                className="absolute -left-2 h-5 w-0.5 rounded-r-full bg-accent shadow-[0_0_10px_var(--accent)]"
                aria-hidden
              />
            )}
            <Icon
              className={cn(
                "relative z-10 h-[18px] w-[18px] transition-transform duration-200",
                active ? "scale-105 text-accent" : "group-hover:scale-105"
              )}
              aria-hidden
            />
            <span className="sr-only">{label}</span>
          </NavLink>
        </Tooltip>
      </li>
    );
  };

  return (
    <nav
      aria-label={t("nav.section")}
      className="sidebar-rail relative z-20 flex w-[64px] shrink-0 flex-col border-r border-line/80 bg-panel/90 backdrop-blur-2xl"
    >
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3.5">
        <ul className="flex flex-col items-center gap-1.5">{primary.map(renderLink)}</ul>
      </div>
      {settingsEntry && (
        <div className="relative px-3 pt-3 pb-3.5 before:absolute before:top-0 before:right-3 before:left-3 before:h-px before:bg-line/80">
          <ul className="flex justify-center">{[settingsEntry].map(renderLink)}</ul>
        </div>
      )}
    </nav>
  );
}
