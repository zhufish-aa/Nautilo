import { motion } from "framer-motion";
import { Tooltip } from "../../components/ui/Tooltip";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { useAgentsStore } from "../../stores/agents";
import { useSessionsStore } from "../../stores/sessions";

const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function tokenLabel(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function ContextUsageIndicator({ sessionId }: { sessionId?: string }): JSX.Element | null {
  const { locale } = useI18n();
  const session = useSessionsStore((state) => state.sessions.find((item) => item.id === sessionId));
  const usage = useSessionsStore((state) => sessionId ? state.contextUsage[sessionId] : undefined);
  const instances = useAgentsStore((state) => state.instances);
  const catalogs = useAgentsStore((state) => state.modelCatalogs);
  if (!sessionId || !session) return null;

  const instanceId = session.target.type === "agent" ? session.target.instanceId : undefined;
  const instance = instances.find((item) => item.id === instanceId);
  const catalog = instance ? catalogs[instance.id] : undefined;
  const modelId = session.model || catalog?.defaultModel;
  const model = catalog?.models.find((item) => item.id === modelId);
  const used = usage?.contextUsed;
  const limit = usage?.contextWindow ?? model?.contextWindow;
  const percentage = used !== undefined && limit
    ? Math.min(100, Math.max(0, (used / limit) * 100))
    : undefined;
  const zh = locale === "zh-CN";
  const tooltip = used !== undefined && limit
    ? `${zh ? "上下文" : "Context"} ${tokenLabel(used)} / ${tokenLabel(limit)} tokens (${Math.round(percentage ?? 0)}%)`
    : used !== undefined
      ? `${zh ? "当前上下文" : "Current context"} ${tokenLabel(used)} tokens · ${zh ? "上限未知" : "limit unavailable"}`
      : limit
        ? `${zh ? "上下文上限" : "Context limit"} ${tokenLabel(limit)} tokens · ${zh ? "等待 Provider 返回使用量" : "waiting for provider usage"}`
        : (zh ? "上下文使用量暂不可用" : "Context usage unavailable");
  const tone = percentage === undefined ? "text-ink-3" : percentage >= 90 ? "text-danger" : percentage >= 75 ? "text-warn" : "text-accent";

  return (
    <Tooltip content={tooltip}>
      <span
        className={cn("relative grid h-8 w-8 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/45", tone)}
        role="img"
        tabIndex={0}
        aria-label={tooltip}
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5 -rotate-90" aria-hidden>
          <circle cx="12" cy="12" r={RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
          {percentage !== undefined ? (
            <motion.circle
              cx="12"
              cy="12"
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              initial={false}
              animate={{ strokeDashoffset: CIRCUMFERENCE * (1 - percentage / 100) }}
              transition={{ type: "spring", stiffness: 260, damping: 30 }}
            />
          ) : (
            <circle cx="12" cy="12" r="1.5" fill="currentColor" opacity="0.55" />
          )}
        </svg>
      </span>
    </Tooltip>
  );
}
