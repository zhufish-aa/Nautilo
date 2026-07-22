import { motion } from "framer-motion";
import { Activity, Gauge, HelpCircle, Pencil, Sparkles, Zap } from "lucide-react";
import type { SlashCommandDefinition, SlashCommandIcon } from "@agenthub/domain";
import { cn } from "../../../lib/utils";

const ICONS: Record<SlashCommandIcon, typeof HelpCircle> = {
  help: HelpCircle,
  model: Sparkles,
  reasoning: Activity,
  speed: Zap,
  status: Gauge,
  usage: Activity,
  rename: Pencil
};

export function SlashCommandMenu({
  commands,
  activeIndex,
  onActiveIndexChange,
  onSelect
}: {
  commands: SlashCommandDefinition[];
  activeIndex: number;
  onActiveIndexChange(index: number): void;
  onSelect(command: SlashCommandDefinition): void;
}): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.99 }}
      transition={{ type: "spring", stiffness: 430, damping: 34 }}
      role="listbox"
      aria-label="斜杠指令"
      className="absolute inset-x-0 bottom-[calc(100%+10px)] z-30 max-h-80 overflow-y-auto rounded-2xl border border-line bg-card/98 p-1.5 shadow-pop backdrop-blur-xl"
    >
      {commands.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-ink-3">没有匹配的指令</p>
      ) : commands.map((command, index) => {
        const Icon = ICONS[command.icon];
        return (
          <button
            key={command.id}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            onMouseEnter={() => onActiveIndexChange(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(command)}
            className={cn(
              "grid min-h-11 w-full grid-cols-[24px_minmax(110px,0.42fr)_1fr] items-center gap-2 rounded-xl px-3 py-2 text-left outline-none transition-colors",
              index === activeIndex ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-card-hover"
            )}
          >
            <Icon className="h-4 w-4 text-ink-3" aria-hidden />
            <span className="truncate text-sm font-medium text-ink">{command.title}</span>
            <span className="flex min-w-0 items-center justify-between gap-3">
              <span className="truncate text-xs text-ink-3">{command.description}</span>
              <code className="shrink-0 text-[11px] text-ink-3">{command.name}</code>
            </span>
          </button>
        );
      })}
    </motion.div>
  );
}
