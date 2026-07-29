import { motion } from "framer-motion";
import { TextQuote } from "lucide-react";
import type { PromptSnippet } from "../../../lib/snippets";
import { cn } from "../../../lib/utils";

/** "//" snippet picker: inserts a saved prompt into the composer. */
export function SnippetMenu({
  snippets,
  activeIndex,
  onActiveIndexChange,
  onSelect
}: {
  snippets: PromptSnippet[];
  activeIndex: number;
  onActiveIndexChange(index: number): void;
  onSelect(snippet: PromptSnippet): void;
}): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.99 }}
      transition={{ type: "spring", stiffness: 430, damping: 34 }}
      role="listbox"
      aria-label="提示词片段"
      className="absolute inset-x-0 bottom-[calc(100%+10px)] z-30 max-h-80 overflow-y-auto rounded-2xl border border-line bg-card/98 p-1.5 shadow-pop backdrop-blur-xl"
    >
      {snippets.map((snippet, index) => (
        <button
          key={snippet.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          onMouseEnter={() => onActiveIndexChange(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(snippet)}
          className={cn(
            "grid min-h-11 w-full grid-cols-[24px_minmax(110px,0.42fr)_1fr] items-center gap-2 rounded-xl px-3 py-2 text-left outline-none transition-colors",
            index === activeIndex ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-card-hover"
          )}
        >
          <TextQuote className="h-4 w-4 text-ink-3" aria-hidden />
          <span className="truncate text-sm font-medium text-ink">{snippet.title}</span>
          <span className="truncate text-xs text-ink-3">{snippet.text}</span>
        </button>
      ))}
    </motion.div>
  );
}
