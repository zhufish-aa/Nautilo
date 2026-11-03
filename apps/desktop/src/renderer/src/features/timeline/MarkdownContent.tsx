import { Children, Fragment, memo, useMemo, useState, cloneElement, isValidElement, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
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
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
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
      // A file reference always contains a path separator; skip the regex
      // entirely for plain text (long messages render many paragraphs).
      if (!child.includes("/") && !child.includes("\\")) return child;
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

export const MarkdownContent = memo(function MarkdownContent({
  source,
  inverted = false,
  onOpenLocalFile
}: {
  source: string;
  inverted?: boolean;
  onOpenLocalFile?: OpenLocalFile;
}): JSX.Element {
  const { t } = useI18n();
  // Cache only this mounted message. Global JSX caches retain obsolete file
  // handlers and every partial streaming source, leaking large conversations.
  return useMemo(() => renderMarkdown(normalizeMarkdownLocalLinks(source), inverted, onOpenLocalFile, t), [source, inverted, onOpenLocalFile, t]);
});

function CodeBlock({ children }: { children?: ReactNode }): JSX.Element {
  const { locale } = useI18n();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(textOf(children).replace(/\n$/, ""));
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };
  return (
    <div className="group/code relative my-3 overflow-hidden rounded-xl border border-line bg-card">
      <button type="button" onClick={() => void copy()} aria-label={locale === "zh-CN" ? "复制代码" : "Copy code"} title={locale === "zh-CN" ? "复制代码" : "Copy code"}
        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-card text-ink-3 transition-colors hover:bg-card-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
        {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      </button>
      <pre className="max-w-full overflow-auto p-4 pr-12 font-mono text-[13px] leading-relaxed text-ink-2 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit">{children}</pre>
      {copyError && <p role="status" className="px-4 pb-2 text-xs text-danger">{locale === "zh-CN" ? "无法复制，请选择代码后复制。" : "Could not copy. Select the code and copy it manually."}</p>}
    </div>
  );
}

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
    <div className={cn("min-w-0 break-words text-[15px] leading-7", inverted ? "text-on-accent" : "text-ink")}>
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
          return <code className={cn("rounded px-1.5 py-0.5 font-mono text-[12px]", inverted ? "bg-white/15" : "bg-card-hover text-ink")}>{children}</code>;
        },
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        // table-fixed keeps column widths driven by the container (never the
        // widest cell), so a long path/code cell wraps instead of blowing the
        // table past the message bubble / timeline width.
        table: ({ children }) => <table className="my-3 w-full table-fixed border-collapse text-left text-[12px]">{children}</table>,
        th: ({ children }) => <th className="break-words border border-line bg-card-hover px-2.5 py-2 font-semibold">{children}</th>,
        td: ({ children }) => <td className="break-words border border-line px-2.5 py-2 align-top">{renderWithFileRefs(children, inverted, onOpenLocalFile)}</td>,
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
