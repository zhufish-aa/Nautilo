import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Briefcase, Code2 } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { Tooltip } from "../../components/ui/Tooltip";

/**
 * Claude-style Code/Work segmented switch, shown in the workbench header.
 * Ctrl+1 → Code (/sessions), Ctrl+2 → Work (/work).
 */
export function ModeSwitch({ mode }: { mode: "code" | "work" }): JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      if (event.key === "1") {
        event.preventDefault();
        navigate("/sessions");
      } else if (event.key === "2") {
        event.preventDefault();
        navigate("/work");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  const entries = [
    { key: "code" as const, path: "/sessions", icon: Code2, label: t("modeSwitch.code"), shortcut: "Ctrl+1" },
    { key: "work" as const, path: "/work", icon: Briefcase, label: t("modeSwitch.work"), shortcut: "Ctrl+2" }
  ];

  return (
    <div
      role="tablist"
      aria-label={t("modeSwitch.label")}
      className="flex items-center gap-0.5 rounded-full border border-line bg-card/80 p-0.5 backdrop-blur-xl"
    >
      {entries.map((entry) => {
        const active = entry.key === mode;
        const Icon = entry.icon;
        return (
          <Tooltip key={entry.key} content={`${entry.label} · ${entry.shortcut}`}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => navigate(entry.path)}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition-colors",
                active ? "bg-ink text-canvas shadow-sm" : "text-ink-3 hover:bg-card-hover hover:text-ink"
              )}
            >
              <Icon className="h-3 w-3" aria-hidden />
              {entry.label}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
