import { FileCode2, ImageIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { isImagePath, resolveFileOpenTarget, type FileReference } from "../../lib/file-references";
import { openFilePreview } from "../../stores/file-preview";
import { openLightbox } from "../../stores/lightbox";
import { useI18n } from "../../lib/i18n";
import { artifactUrlForPath, openFileWithToast, popupFileMenu } from "./media-actions";

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
  inverted = false,
  onOpenLocalFile
}: {
  reference: FileReference;
  label?: string;
  inverted?: boolean;
  /** Work mode only: previewable project files route to the preview pane. */
  onOpenLocalFile?: (path: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const rawLabel = label ?? `${basename(reference.path)}${reference.line !== undefined ? `:${reference.line}` : ""}`;
  const name = shortenPathLabel(rawLabel);
  const imagePath = isImagePath(reference.path);
  // Work mode (handler present): previewable files (PDF/Office/text/image…)
  // open in the right-hand preview pane; legacy .doc/.ppt keep the system
  // app. Without a handler the Code-mode behavior is untouched: Office opens
  // externally, code/text keeps the preview drawer. Right-click offers the
  // native menu (open / show in folder / copy path).
  const target = resolveFileOpenTarget(reference.path, onOpenLocalFile !== undefined);
  return (
    <button
      type="button"
      title={reference.path}
      onClick={(event) => {
        event.stopPropagation();
        if (imagePath && !onOpenLocalFile) {
          openLightbox({ src: artifactUrlForPath(reference.path), name: basename(reference.path), path: reference.path });
        } else if (target === "local-preview") onOpenLocalFile!(reference.path);
        else if (target === "external") void openFileWithToast(reference.path, t);
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
      {imagePath ? <ImageIcon className="h-3 w-3 shrink-0" aria-hidden /> : <FileCode2 className="h-3 w-3 shrink-0" aria-hidden />}
      <span className="truncate">{name}</span>
    </button>
  );
}
