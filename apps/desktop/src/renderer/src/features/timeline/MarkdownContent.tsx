import { Children, Fragment, createContext, memo, useContext, useLayoutEffect, useMemo, useRef, useState, cloneElement, isValidElement, type MouseEvent, type ReactElement, type ReactNode, type RefObject } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import { classifyLocalHref, isImagePath, isExternalOpenPath, parseFileReference, splitTextByFileReferences } from "../../lib/file-references";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { highlightCode } from "../../lib/highlight";
import { cn } from "../../lib/utils";
import { useMarkdownFragments } from "../../lib/use-markdown-fragments";
import { useInitialMarkdownMount } from "../../lib/use-initial-markdown-mount";
import { useMarkdownInteractionGuard } from "../../lib/use-markdown-interaction-guard";
import type { MarkdownNode } from "../../lib/markdown-parse";
import { decorateStreamText, updateStreamingMarkdown, type StreamingMarkdown } from "../../lib/streaming-markdown";
import { openFilePreview } from "../../stores/file-preview";
import { openLightbox } from "../../stores/lightbox";
import { FileRefChip } from "./FileRefChip";
import { TimelineImage } from "./TimelineImage";
import { artifactUrlForPath, openFileWithToast, popupFileMenu, popupImageMenu } from "./media-actions";
import { PreviewCopyButton } from "../work/preview/PreviewCopyButton";

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** Interactive elements whose children must not be rewritten into chips. */
const SKIP_TAGS = new Set(["a", "code", "pre", "button", "img"]);
const StreamingCode = createContext(false);

type OpenLocalFile = (path: string) => void;
type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;
type RenderInlineText = (text: string) => ReactNode;

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/** Rewrites plain-text file paths inside rendered markdown into clickable chips. */
function renderWithFileRefs(children: ReactNode, inverted: boolean, onOpenLocalFile?: OpenLocalFile, renderText?: RenderInlineText): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      // A file reference always contains a path separator; skip the regex
      // entirely for plain text (long messages render many paragraphs).
      if (renderText && child.includes("@")) {
        return Children.map(renderText(child), part => typeof part === "string" ? renderWithFileRefs(part, inverted, onOpenLocalFile) : part);
      }
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
      return cloneElement(element, {}, renderWithFileRefs(element.props.children, inverted, onOpenLocalFile, renderText));
    }
    return child;
  });
}

export const MarkdownContent = memo(function MarkdownContent({
  source,
  inverted = false,
  onOpenLocalFile,
  streaming = false,
  fade = false,
  document = false,
  scrollableTableLabel,
  onContentLayout,
  renderInlineText
}: {
  source: string;
  renderInlineText?: RenderInlineText;
  inverted?: boolean;
  onOpenLocalFile?: OpenLocalFile;
  streaming?: boolean;
  fade?: boolean;
  document?: boolean;
  scrollableTableLabel?: string;
  onContentLayout?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const components = useMemo(() => createMarkdownComponents(inverted, onOpenLocalFile, t, scrollableTableLabel, document, renderInlineText), [inverted, onOpenLocalFile, t, scrollableTableLabel, document, renderInlineText]);
  const rawRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const streamed = useRef(streaming);
  streamed.current ||= streaming;
  const held = useMarkdownInteractionGuard(rootRef, rawRef);
  const { fragments, pending, unformatted } = useMarkdownFragments(source, held, !streaming, streamed.current);
  const liveCache = useRef<StreamingMarkdown>();
  const mount = useInitialMarkdownMount(fragments, held, streamed.current);
  const live = streaming || (streamed.current && !mount.showFormatted);
  const liveLayout = useMemo(() => {
    if (!live) return undefined;
    const previous = liveCache.current;
    if (previous && (previous.source === source || (held && source.startsWith(previous.source)))) return previous;
    return updateStreamingMarkdown(previous, source, streaming);
  }, [source, live, streaming, held]);
  useLayoutEffect(() => { liveCache.current = liveLayout; }, [liveLayout]);
  const showFormatted = live || mount.showFormatted;
  const pendingSource = liveLayout ? source.slice(liveLayout.source.length) : unformatted;
  const raw = !showFormatted ? source : streamed.current && !held ? "" : pendingSource;
  const visibleFragments = liveLayout ? [...liveLayout.fixed, ...liveLayout.tail] : fragments?.slice(0, mount.count);
  useLayoutEffect(() => {
    onContentLayout?.();
  }, [fragments, liveLayout, mount.count, showFormatted, raw, onContentLayout]);
  return (
    <div ref={rootRef} data-markdown-streaming={streaming || undefined}
      aria-busy={streaming || pending || (fragments !== undefined && !showFormatted) || undefined} className={cn("markdown-content min-w-0 break-words", inverted ? "text-on-accent" : "text-ink")}>
      {/* Keep one wrapper so first/last-child Markdown styles do not reset at
          fragment boundaries. Hidden staging is neither focusable nor spoken;
          revealing changes visibility only, never moves/remounts the nodes. */}
      <div data-markdown-formatted="" hidden={!showFormatted} aria-hidden={!showFormatted || undefined}
        {...{ inert: showFormatted ? undefined : "" }} style={{ display: showFormatted ? "contents" : "none" }}>
        {visibleFragments?.map((serialized, index) => {
          const active = streaming && index === visibleFragments.length - 1;
          return <MarkdownFragment key={index} serialized={serialized} components={components} active={active} fade={active && fade} />;
        })}
      </div>
      {/* Complete source remains available during initial DOM preparation;
          after the switch only new streaming text awaits formatting. */}
      {raw && <MarkdownRawSource text={raw} elementRef={rawRef} />}
    </div>
  );
});

function MarkdownRawSource({ text, elementRef }: { text: string; elementRef: RefObject<HTMLDivElement> }): JSX.Element {
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const node = element.firstChild;
    if (node?.nodeType === Node.TEXT_NODE && text.startsWith(node.textContent ?? "")) {
      (node as Text).appendData(text.slice(node.textContent?.length ?? 0));
    } else element.textContent = text;
  }, [text, elementRef]);
  return <div ref={elementRef} data-markdown-raw="" className="whitespace-pre-wrap" />;
}

/** Exact parsed-content equality lets React skip completed fragments. These
 * are AST fragments, not independently parsed Markdown: cross-fragment links,
 * footnotes and unfinished syntax have already been resolved globally. */
const MarkdownFragment = memo(function MarkdownFragment({ serialized, components, active, fade }: {
  serialized: string; components: Components; active: boolean; fade: boolean;
}): JSX.Element {
  const wasActive = useRef(false);
  const seen = useRef(0);
  const decorate = active || wasActive.current;
  const { tree, length } = useMemo(() => {
    const tree: MarkdownNode = JSON.parse(serialized);
    const length = decorate ? decorateStreamText(tree, fade ? seen.current : Infinity) : 0;
    return { tree, length };
  }, [serialized, decorate, fade]);
  useLayoutEffect(() => {
    seen.current = Math.max(seen.current, length);
    wasActive.current ||= active;
  }, [length, active]);
  const rehypePlugins = useMemo(() => [() => () => tree], [tree]);
  // Keep react-markdown's default HTML escaping and URL sanitization. Never
  // convert the worker result into innerHTML or enable rehype-raw.
  return <StreamingCode.Provider value={active}><ReactMarkdown rehypePlugins={rehypePlugins} components={components}>{""}</ReactMarkdown></StreamingCode.Provider>;
});

function StreamFadeSegment({ children, fresh }: { children: ReactNode; fresh: boolean }): JSX.Element {
  const node = useRef<HTMLSpanElement>(null);
  const entrance = useRef(fresh);
  useLayoutEffect(() => {
    const element = node.current;
    if (!entrance.current || !element) return;
    const finish = () => {
      element.removeEventListener("animationend", finish);
      element.removeEventListener("animationcancel", finish);
      element.classList.remove("stream-fade-seg");
    };
    element.classList.add("stream-fade-seg");
    element.addEventListener("animationend", finish);
    element.addEventListener("animationcancel", finish);
    return finish;
  }, []);
  return <span ref={node} data-stream-segment="">{children}</span>;
}

function CodeBlock({ children }: { children?: ReactNode }): JSX.Element {
  const { locale } = useI18n();
  const streaming = useContext(StreamingCode);
  const code = Children.toArray(children).find(isValidElement<{ className?: string }>);
  const language = code?.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
  const text = textOf(children);
  const highlighted = useMemo(() => !streaming && language ? highlightCode(text, "", language) : undefined, [streaming, text, language]);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text.replace(/\n$/, ""));
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
      <pre className="max-w-full overflow-auto p-4 pr-12 font-mono text-[13px] font-normal leading-relaxed text-ink-2 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit">
        {highlighted === undefined ? children : <code className={code?.props.className} dangerouslySetInnerHTML={{ __html: highlighted }} />}
      </pre>
      {copyError && <p role="status" className="px-4 pb-2 text-xs text-danger">{locale === "zh-CN" ? "无法复制，请选择代码后复制。" : "Could not copy. Select the code and copy it manually."}</p>}
    </div>
  );
}

function DocumentCodeBlock({ children }: { children?: ReactNode }): JSX.Element {
  const { locale } = useI18n();
  const code = Children.toArray(children).find(isValidElement<{ className?: string }>);
  const language = code?.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
  const text = textOf(children).replace(/\n$/, "");
  const html = useMemo(() => highlightCode(text, "", language), [text, language]);
  return <div className="preview-code-block">
    <div className="preview-code-block-toolbar">
      <span>{language ?? (locale === "zh-CN" ? "代码" : "Code")}</span>
      <PreviewCopyButton value={text} label={locale === "zh-CN" ? "复制代码" : "Copy code"} />
    </div>
    <pre tabIndex={0}><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
  </div>;
}

function createMarkdownComponents(inverted: boolean, onOpenLocalFile: OpenLocalFile | undefined, t: Translate, scrollableTableLabel?: string, document = false, renderText?: RenderInlineText): Components {
  const inline = (children: ReactNode) => renderWithFileRefs(children, inverted, onOpenLocalFile, renderText);
  const linkProps = (href: string | undefined): Record<string, unknown> => {
    const classification = classifyLocalHref(href, !!onOpenLocalFile);
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
  return {
        span: ({ children, node, ...props }) => node?.properties.dataStreamSegment
          ? <StreamFadeSegment fresh={node.properties.dataStreamNew === true}>{children}</StreamFadeSegment>
          : <span {...props}>{children}</span>,
        p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{inline(children)}</p>,
        strong: ({ children }) => <strong className="font-semibold">{renderText ? inline(children) : children}</strong>,
        h1: ({ children }) => <h1 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{renderText ? inline(children) : children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-4 text-base font-semibold first:mt-0">{renderText ? inline(children) : children}</h2>,
        h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-[length:inherit] font-semibold first:mt-0">{renderText ? inline(children) : children}</h3>,
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
        li: ({ children }) => <li>{inline(children)}</li>,
        blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-accent/50 pl-3 text-ink-2">{children}</blockquote>,
        a: ({ children, href }) => <a className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent" {...linkProps(href)}>{children}</a>,
        code: ({ children, className }) => {
          if (document) return <code className={className}>{children}</code>;
          if (className) return <code className={cn("font-mono text-[12px] font-normal", className)}>{children}</code>;
          const reference = parseFileReference(textOf(children));
          if (reference) return <FileRefChip reference={reference} label={textOf(children)} inverted={inverted} onOpenLocalFile={onOpenLocalFile} />;
          return <code className={cn("rounded px-1.5 py-0.5 font-mono text-[12px] font-normal", inverted ? "bg-white/15" : "bg-card-hover text-ink")}>{children}</code>;
        },
        pre: ({ children }) => document ? <DocumentCodeBlock>{children}</DocumentCodeBlock> : <CodeBlock>{children}</CodeBlock>,
        // table-fixed keeps column widths driven by the container (never the
        // widest cell), so a long path/code cell wraps instead of blowing the
        // table past the message bubble / timeline width.
        table: ({ children }) => {
          const table = <table className="my-3 w-full table-fixed border-collapse text-left text-[12px]">{children}</table>;
          return scrollableTableLabel
            ? <div className="markdown-table-scroll" role="region" aria-label={scrollableTableLabel} tabIndex={0}>{table}</div>
            : table;
        },
        th: ({ children }) => <th className="break-words border border-line bg-card-hover px-2.5 py-2 font-semibold">{children}</th>,
        td: ({ children }) => <td className="break-words border border-line px-2.5 py-2 align-top">{inline(children)}</td>,
        hr: () => <hr className="my-4 border-line" />,
        img: ({ src, alt }) => {
          if (typeof src !== "string") return null;
          const classification = classifyLocalHref(src);
          if (classification.kind === "local" && isImagePath(classification.path)) {
            return <TimelineImage src={artifactUrlForPath(classification.path)} path={classification.path} name={alt ?? basename(classification.path)} alt={alt ?? ""} className="my-2 max-h-72 max-w-full rounded-xl border border-line object-contain" />;
          }
          return <TimelineImage src={src} alt={alt ?? ""} className="my-2 max-h-72 max-w-full rounded-xl border border-line object-contain" />;
        }
  };
}
