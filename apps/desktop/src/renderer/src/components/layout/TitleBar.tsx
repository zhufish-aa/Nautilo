import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import nautiloIcon from "../../assets/nautilo-icon.png";
import { getBridge, isElectron } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";

function WindowButton({
  label,
  onClick,
  danger,
  windowAction,
  children
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** Stable hook for theme styling (e.g. macOS traffic lights). */
  windowAction: "minimize" | "maximize" | "close";
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      data-window={windowAction}
      className={cn(
        "no-drag flex h-full w-11 items-center justify-center text-ink-3 transition-colors outline-none",
        "focus-visible:bg-accent-soft focus-visible:text-ink",
        danger ? "hover:bg-danger hover:text-white" : "hover:bg-accent-soft hover:text-ink"
      )}
    >
      {children}
    </button>
  );
}

export function TitleBar(): JSX.Element {
  const { t } = useI18n();
  const bridge = getBridge();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    void bridge.window.isMaximized().then(setMaximized);
    return bridge.window.onMaximizedChange(setMaximized);
  }, [bridge]);

  return (
    <header className="titlebar-root drag-region relative z-30 flex h-11 shrink-0 items-stretch justify-between border-b border-line bg-panel backdrop-blur-xl">
      <div className="titlebar-brand flex items-center gap-2.5 pl-4">
        <span
          aria-hidden
          className="titlebar-logo flex h-7 w-7 items-center justify-center overflow-hidden rounded-lg"
        >
          <img src={nautiloIcon} alt="" className="h-full w-full object-contain" />
        </span>
        <span className="titlebar-name text-[13px] font-semibold tracking-tight text-ink">
          {t("app.name")}
        </span>
        {!isElectron && (
          <span className="ml-2 rounded-md border border-warn/30 bg-warn/10 px-1.5 py-0.5 text-[11px] text-warn">
            {t("app.browserBadge")}
          </span>
        )}
      </div>

      {bridge && (
        <div className="titlebar-controls flex items-stretch" role="group" aria-label="Window">
          <WindowButton label={t("app.windowMinimize")} windowAction="minimize" onClick={() => void bridge.window.minimize()}>
            <Minus className="h-4 w-4" aria-hidden />
          </WindowButton>
          <WindowButton
            label={maximized ? t("app.windowRestore") : t("app.windowMaximize")}
            windowAction="maximize"
            onClick={() => void bridge.window.toggleMaximize()}
          >
            {maximized ? (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Square className="h-3.5 w-3.5" aria-hidden />
            )}
          </WindowButton>
          <WindowButton label={t("app.windowClose")} danger windowAction="close" onClick={() => void bridge.window.close()}>
            <X className="h-4 w-4" aria-hidden />
          </WindowButton>
        </div>
      )}
    </header>
  );
}
