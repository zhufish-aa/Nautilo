import { Children, Fragment, cloneElement, isValidElement, type MouseEvent, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { classifyLocalHref, isImagePath, isExternalOpenPath, normalizeMarkdownLocalLinks, parseFileReference, splitTextByFileReferences } from "../../lib/file-references";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { openFilePreview } from "../../stores/file-preview";
import { openLightbox } from "../../stores/lightbox";
import { FileRefChip } from "./FileRefChip";
import { TimelineImage } from "./TimelineImage";
import { artifactUrlForPath, openFileWithToast, popupFileMenu, popupImageMenu } from "./media-actions";

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

/** Interactive elements whose children must not be rewritten into chips. */
const SKIP_TAGS = new Set(["a", "code", "pre", "button", "img"]);

type OpenLocalFile = (path: string) => void;
type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/** Rewrites plain-text file paths inside rendered markdown into clickable chips. */
function renderWithFileRefs(children: ReactNode, inverted: boolean, onOpenLocalFile?: OpenLocalFile): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      const segments = splitTextByFileReferences(child);
      if (segments.length === 1 && segments[0]?.kind === "text") return child;
      return segments.map((segment, index) =>
        segment.kind === "text"
          ? <Fragment key={index}>{segment.value}</Fragment>
          : <FileRefChip key={index} reference={segment.reference} label={segment.value} inverted={inverted} onOpenLocalFile={onOpenLocalFile} />
      );
    }
    if (isValidElement(child) && typeof child.type === "string" && !SKIP_TAGS.has(child.type)) {
      const element = child as ReactElement<{ children?: ReactNode }>;
      return cloneElement(element, {}, renderWithFileRefs(element.props.children, inverted, onOpenLocalFile));
    }
    return child;
  });
}

export function MarkdownContent({
  source,
  inverted = false,
  onOpenLocalFile
}: {
  source: string;
  inverted?: boolean;
  /** Work mode only: local file links/chips route to the preview pane. */
  onOpenLocalFile?: OpenLocalFile;
}): JSX.Element {
  const { locale, t } = useI18n();
  const normalizedSource = normalizeMarkdownLocalLinks(source);
  // Remounts (mode switches, drawer toggles) would re-parse every message in
  // the timeline; the rendered tree for a static source never changes, so
  // cache it. Streaming messages churn through sources and simply miss.
  const key = `${locale}${inverted ? "1" : "0"}${onOpenLocalFile ? "L" : ""}${normalizedSource}`;
  const cached = markdownRenderCache.get(key);
  if (cached) return cached;
  const rendered = renderMarkdown(normalizedSource, inverted, onOpenLocalFile, t);
  if (markdownRenderCache.size >= 150) {
    const oldest = markdownRenderCache.keys().next().value;
    if (oldest !== undefined) markdownRenderCache.delete(oldest);
  }
  markdownRenderCache.set(key, rendered);
  return rendered;
}

const markdownRenderCache = new Map<string, JSX.Element>();

function renderMarkdown(source: string, inverted: boolean, onOpenLocalFile: OpenLocalFile | undefined, t: Translate): JSX.Element {
  const linkProps = (href: string | undefined): Record<string, unknown> => {
    const classification = classifyLocalHref(href);
    if (classification.kind === "local") {
      const path = classification.path;
      const imagePath = isImagePath(path);
      return {
        href: imagePath ? artifactUrlForPath(path) : href,
        onClick: (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          if (onOpenLocalFile) onOpenLocalFile(path);
          else if (imagePath) openLightbox({ src: artifactUrlForPath(path), name: basename(path), path });
          else if (isExternalOpenPath(path)) void openFileWithToast(path, t);
          else openFilePreview({ path });
        },
        onContextMenu: (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          if (imagePath) void popupImageMenu({ src: artifactUrlForPath(path), name: basename(path), path }, t);
          else void popupFileMenu(path, t);
        }
      };
    }
    return { href, target: "_blank", rel: "noreferrer noopener" };
  };
  return (
    <div className={cn("min-w-0 break-words text-sm leading-relaxed", inverted ? "text-on-accent" : "text-ink")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
        p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{renderWithFileRefs(children, inverted, onOpenLocalFile)}</p>,
        h1: ({ children }) => <h1 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0">{children}</h3>,
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
        li: ({ children }) => <li>{renderWithFileRefs(children, inverted, onOpenLocalFile)}</li>,
        blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-accent/50 pl-3 text-ink-2">{children}</blockquote>,
        a: ({ children, href }) => <a className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent" {...linkProps(href)}>{children}</a>,
        code: ({ children, className }) => {
          if (className) return <code className={cn("font-mono text-[12px]", className)}>{children}</code>;
          const reference = parseFileReference(textOf(children));
          if (reference) return <FileRefChip reference={reference} label={textOf(children)} inverted={inverted} onOpenLocalFile={onOpenLocalFile} />;
          return <code className={cn("rounded px-1.5 py-0.5 font-mono text-[12px]", inverted ? "bg-white/15" : "bg-card-hover text-accent")}>{children}</code>;
        },
        pre: ({ children }) => <pre className="my-2 max-w-full overflow-auto rounded-xl border border-line bg-card-hover p-3 font-mono text-[12px] leading-relaxed text-ink-2">{children}</pre>,
        table: ({ children }) => <table className="my-3 w-full border-collapse overflow-hidden text-left text-[12px]">{children}</table>,
        th: ({ children }) => <th className="border border-line bg-card-hover px-2.5 py-2 font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-line px-2.5 py-2 align-top">{renderWithFileRefs(children, inverted, onOpenLocalFile)}</td>,
        hr: () => <hr className="my-4 border-line" />,
        img: ({ src, alt }) => {
          if (typeof src !== "string") return null;
          const classification = classifyLocalHref(src);
          if (classification.kind === "local" && isImagePath(classification.path)) {
            return <TimelineImage src={artifactUrlForPath(classification.path)} path={classification.path} name={alt ?? basename(classification.path)} alt={alt ?? ""} className="my-2 max-h-72 max-w-full rounded-xl border border-line object-contain" />;
          }
          return <TimelineImage src={src} alt={alt ?? ""} className="my-2 max-h-72 max-w-full rounded-xl border border-line object-contain" />;
        }
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
