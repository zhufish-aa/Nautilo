import { useEffect, useState } from "react";
import { Copy, Minus, Square, X, Zap } from "lucide-react";
import { getBridge, isElectron } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";

function WindowButton({
  label,
  onClick,
  danger,
  children
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
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
    <header className="drag-region relative z-30 flex h-11 shrink-0 items-stretch justify-between border-b border-line bg-panel backdrop-blur-xl">
      <div className="flex items-center gap-2.5 pl-4">
        <span
          aria-hidden
          className="flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent-2 shadow-[0_0_16px_-2px_var(--accent)]"
        >
          <Zap className="h-3.5 w-3.5 text-white" strokeWidth={2.5} />
        </span>
        <span className="text-[13px] font-semibold tracking-tight text-ink">
          {t("app.name")}
        </span>
        <span className="hidden text-xs text-ink-3 sm:inline">{t("app.tagline")}</span>
        {!isElectron && (
          <span className="ml-2 rounded-md border border-warn/30 bg-warn/10 px-1.5 py-0.5 text-[11px] text-warn">
            {t("app.browserBadge")}
          </span>
        )}
      </div>

      {bridge && (
        <div className="flex items-stretch" role="group" aria-label="Window">
          <WindowButton label={t("app.windowMinimize")} onClick={() => void bridge.window.minimize()}>
            <Minus className="h-4 w-4" aria-hidden />
          </WindowButton>
          <WindowButton
            label={maximized ? t("app.windowRestore") : t("app.windowMaximize")}
            onClick={() => void bridge.window.toggleMaximize()}
          >
            {maximized ? (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Square className="h-3.5 w-3.5" aria-hidden />
            )}
          </WindowButton>
          <WindowButton label={t("app.windowClose")} danger onClick={() => void bridge.window.close()}>
            <X className="h-4 w-4" aria-hidden />
          </WindowButton>
        </div>
      )}
    </header>
  );
}
