import { FileCode2 } from "lucide-react";
import { cn } from "../../lib/utils";
import type { FileReference } from "../../lib/file-references";
import { openFilePreview } from "../../stores/file-preview";

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/** Clickable inline chip for a file reference detected in message text. */
export function FileRefChip({
  reference,
  label,
  inverted = false
}: {
  reference: FileReference;
  label?: string;
  inverted?: boolean;
}): JSX.Element {
  const name = label ?? `${basename(reference.path)}${reference.line !== undefined ? `:${reference.line}` : ""}`;
  return (
    <button
      type="button"
      title={reference.path}
      onClick={(event) => {
        event.stopPropagation();
        openFilePreview(reference);
      }}
      className={cn(
        "mx-0.5 inline-flex max-w-full translate-y-[-1px] cursor-pointer items-center gap-1 rounded-md border px-1.5 py-px align-baseline font-mono text-[11px] leading-5 transition-colors",
        inverted
          ? "border-white/25 bg-white/10 text-on-accent hover:bg-white/20"
          : "border-line bg-card-hover text-accent hover:border-accent/50 hover:bg-accent-soft"
      )}
    >
      <FileCode2 className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
    </button>
  );
}
