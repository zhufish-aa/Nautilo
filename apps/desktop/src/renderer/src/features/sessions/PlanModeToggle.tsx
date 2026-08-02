import { motion } from "framer-motion";
import { ListChecks } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { configureWorkbenchSession } from "../../lib/orchestration-runtime";
import { permissionModesFor } from "../../lib/provider-catalog";
import { useAgentsStore } from "../../stores/agents";
import { useSessionsStore } from "../../stores/sessions";

const PLAN_MODE = "plan";

/** One-click toggle for the CLI-native plan permission mode, on providers that expose it. */
export function PlanModeToggle({ sessionId, disabled }: { sessionId?: string; disabled?: boolean }): JSX.Element | null {
  const { t } = useI18n();
  const session = useSessionsStore((state) => state.sessions.find((item) => item.id === sessionId));
  const instances = useAgentsStore((state) => state.instances);
  const instanceId = session?.target.type === "agent" ? session.target.instanceId : undefined;
  const instance = instances.find((item) => item.id === instanceId);

  if (!sessionId || !instance) return null;
  if (!permissionModesFor(instance.providerId).some((mode) => mode.value === PLAN_MODE)) return null;

  const sessionPermissionMode = session?.permissionMode?.trim();
  const instancePermissionMode = instance.permissionMode?.trim();
  const active = (sessionPermissionMode || instancePermissionMode) === PLAN_MODE;
  const toggle = (): void => {
    // Turning plan off normally just drops the session override, but an instance
    // that itself defaults to plan needs an explicit non-plan override instead.
    const next = active ? (instancePermissionMode === PLAN_MODE ? "default" : undefined) : PLAN_MODE;
    void configureWorkbenchSession(sessionId, { permissionMode: next });
  };

  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.94 }}
      onClick={toggle}
      disabled={disabled}
      aria-pressed={active}
      aria-label={t("sessions.composer.planMode")}
      title={active ? t("sessions.composer.planModeDisable") : t("sessions.composer.planModeEnable")}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/35 disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "border-accent/40 bg-accent-soft text-accent"
          : "border-line-strong bg-card text-ink-2 hover:bg-card-hover hover:text-ink"
      )}
    >
      <ListChecks className="h-3.5 w-3.5" aria-hidden />
      {t("sessions.composer.planMode")}
    </motion.button>
  );
}
