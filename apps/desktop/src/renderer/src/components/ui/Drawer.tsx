import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useI18n } from "../../lib/i18n";

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  defaultWidth = 520,
  minWidth = 380
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  defaultWidth?: number;
  minWidth?: number;
}): JSX.Element {
  const { t } = useI18n();
  const [width, setWidth] = useState(defaultWidth);

  useEffect(() => {
    if (open) setWidth(defaultWidth);
  }, [open, defaultWidth]);

  const clampWidth = (value: number): number =>
    Math.max(minWidth, Math.min(window.innerWidth * 0.94, value));

  const startResize = (event: ReactMouseEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const previousSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: MouseEvent): void => {
      setWidth(clampWidth(startWidth + (startX - moveEvent.clientX)));
    };
    const onUp = (): void => {
      document.body.style.userSelect = previousSelect;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[4px]"
            onClick={onClose}
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 360, damping: 36 }}
            style={{ width }}
            className="fixed inset-y-0 right-0 z-50 flex max-w-[94vw] flex-col border-l border-line bg-card shadow-pop"
          >
            {/* Left-edge resize handle */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="resize"
              tabIndex={0}
              onMouseDown={startResize}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") setWidth((value) => clampWidth(value + 24));
                if (event.key === "ArrowRight") setWidth((value) => clampWidth(value - 24));
              }}
              className="group absolute inset-y-0 -left-1.5 z-10 w-3 cursor-ew-resize outline-none"
            >
              <div className="mx-auto h-full w-0.5 bg-transparent transition-colors group-hover:bg-accent/50 group-focus-visible:bg-accent/70" />
            </div>

            <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-ink">{title}</h2>
                {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
              </div>
              <button
                onClick={onClose}
                aria-label={t("common.close")}
                className="rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-accent-soft hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
