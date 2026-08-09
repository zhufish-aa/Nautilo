import { useState } from "react";
import { ImageOff } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { openLightbox } from "../../stores/lightbox";
import { artifactPathFromSrc, artifactThumbUrlForPath, popupImageMenu } from "./media-actions";

/**
 * Conversation image: click opens the lightbox, right-click shows the native
 * image menu, load failures degrade to a visible placeholder.
 */
export function TimelineImage({
  src,
  alt = "",
  path,
  name,
  className
}: {
  src: string;
  alt?: string;
  path?: string;
  name?: string;
  className?: string;
}): JSX.Element {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const resolvedPath = path ?? artifactPathFromSrc(src);
  // Inline display uses the shell's downscaled thumbnail (full-resolution
  // pastes decode to tens of MB each in the webview); the lightbox and the
  // context menu keep the original URL.
  const displaySrc = resolvedPath ? artifactThumbUrlForPath(resolvedPath) : src;

  if (failed) {
    return (
      <span className={cn("flex h-32 w-full flex-col items-center justify-center gap-1.5 text-ink-3", className)}>
        <ImageOff className="h-5 w-5" aria-hidden />
        <span className="text-xs">{t("sessions.media.imageLoadFailed")}</span>
      </span>
    );
  }

  return (
    <img
      src={displaySrc}
      alt={alt}
      title={t("sessions.media.enlargeHint")}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      onClick={() => openLightbox({ src, name: name ?? alt, path: resolvedPath })}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void popupImageMenu({ src, name: name ?? alt, path: resolvedPath }, t);
      }}
      className={cn("cursor-zoom-in", className)}
    />
  );
}
