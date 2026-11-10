import { useSettingsStore } from "../../stores/settings";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { useI18n } from "../../lib/i18n";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  widthClass = "max-w-lg",
  presentation = "dialog"
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  widthClass?: string;
  presentation?: "dialog" | "workspace";
}): JSX.Element {
  const { t } = useI18n();
  const systemReducedMotion = useReducedMotion();
  const appReducedMotion = useSettingsStore((state) => state.reduceMotion);
  const reduceMotion = systemReducedMotion || appReducedMotion;
  const descriptionId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);

  useLayoutEffect(() => {
    openRef.current = open;
    if (!open) return;
    // These controlled dialogs have no Radix Trigger. Capture the opener before
    // the portal mounts and moves focus, including children with autoFocus.
    const active = document.activeElement;
    if (!contentRef.current?.contains(active)) {
      returnFocusRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
      // AnimatePresence may reuse Content when reopened during its exit. Radix
      // only auto-focuses on mount, so put focus back inside the reused surface.
      contentRef.current?.focus({ preventScroll: true });
    }
  }, [open]);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: reduceMotion ? 1 : 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
                className={cn("fixed inset-0 z-40", presentation === "workspace" ? "bg-transparent" : "bg-black/20")}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content
              asChild
              forceMount
              aria-describedby={description ? descriptionId : undefined}
              onCloseAutoFocus={(event) => {
                // An exit can finish after a quick reopen. It must not pull focus
                // out of the active dialog, or back to a removed route element.
                if (openRef.current) {
                  event.preventDefault();
                  return;
                }
                // A controlled caller may already have moved focus (for example,
                // to the collapsed sidebar's expand button) during the exit.
                const active = document.activeElement;
                if (active instanceof HTMLElement && active !== document.body && !contentRef.current?.contains(active)) {
                  event.preventDefault();
                  return;
                }
                const target = returnFocusRef.current;
                if (target?.isConnected) {
                  event.preventDefault();
                  target.focus({ preventScroll: true });
                }
              }}
            >
              <motion.div
                ref={contentRef}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.985 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduceMotion ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.985 }}
                transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
                className={cn(
                  "ui-dialog fixed top-1/2 left-1/2 z-50 flex max-h-[86vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-pop outline-none",
                  widthClass,
                  presentation === "workspace" && "workspace-dialog"
                )}
              >
                <div className="flex items-start justify-between gap-4 border-b border-line px-6 pt-5 pb-4">
                  <div className="min-w-0">
                    <DialogPrimitive.Title className="text-base font-semibold text-ink">
                      {title}
                    </DialogPrimitive.Title>
                    {description && (
                      <DialogPrimitive.Description
                        id={descriptionId}
                        className="mt-1 break-words text-sm leading-relaxed text-ink-3 [overflow-wrap:anywhere]"
                      >
                        {description}
                      </DialogPrimitive.Description>
                    )}
                  </div>
                  <DialogPrimitive.Close
                    aria-label={t("common.close")}
                    className="rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-accent-soft hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </DialogPrimitive.Close>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
                {footer && (
                  <div className="flex items-center justify-end gap-2.5 border-t border-line bg-card-hover/40 px-6 py-4">
                    {footer}
                  </div>
                )}
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}
