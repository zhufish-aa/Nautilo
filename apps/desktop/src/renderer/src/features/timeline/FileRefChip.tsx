import { FileCode2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { isExternalOpenPath, type FileReference } from "../../lib/file-references";
import { openFilePreview } from "../../stores/file-preview";
import { useI18n } from "../../lib/i18n";
import { openFileWithToast, popupFileMenu } from "./media-actions";

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/**
 * Collapses the middle of a long path label: keeps the root segment (drive
 * or first directory) and the trailing file name so the chip stays readable
 * instead of wrapping across lines.
 */
function shortenPathLabel(label: string, maxLength = 44): string {
  if (label.length <= maxLength) return label;
  const segments = label.split(/[\\/]/).filter(Boolean);
  if (segments.length < 3) return label;
  const shortened = `${segments[0]}/…/${segments.at(-1)}`;
  return shortened.length < label.length ? shortened : label;
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
  const { t } = useI18n();
  const rawLabel = label ?? `${basename(reference.path)}${reference.line !== undefined ? `:${reference.line}` : ""}`;
  const name = shortenPathLabel(rawLabel);
  // Office deliverables and other binaries open with the system default app;
  // previewable code/text files keep the in-app preview drawer. Right-click
  // offers the native menu (open / show in folder / copy path).
  const openExternally = isExternalOpenPath(reference.path);
  return (
    <button
      type="button"
      title={reference.path}
      onClick={(event) => {
        event.stopPropagation();
        if (openExternally) void openFileWithToast(reference.path, t);
        else openFilePreview(reference);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void popupFileMenu(reference.path, t);
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
