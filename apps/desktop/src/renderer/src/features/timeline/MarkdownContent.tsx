import { Children, Fragment, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseFileReference, splitTextByFileReferences } from "../../lib/file-references";
import { cn } from "../../lib/utils";
import { FileRefChip } from "./FileRefChip";
import { TimelineImage } from "./TimelineImage";

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

/** Interactive elements whose children must not be rewritten into chips. */
const SKIP_TAGS = new Set(["a", "code", "pre", "button", "img"]);

/** Rewrites plain-text file paths inside rendered markdown into clickable chips. */
function renderWithFileRefs(children: ReactNode, inverted: boolean): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      const segments = splitTextByFileReferences(child);
      if (segments.length === 1 && segments[0]?.kind === "text") return child;
      return segments.map((segment, index) =>
        segment.kind === "text"
          ? <Fragment key={index}>{segment.value}</Fragment>
          : <FileRefChip key={index} reference={segment.reference} label={segment.value} inverted={inverted} />
      );
    }
    if (isValidElement(child) && typeof child.type === "string" && !SKIP_TAGS.has(child.type)) {
      const element = child as ReactElement<{ children?: ReactNode }>;
      return cloneElement(element, {}, renderWithFileRefs(element.props.children, inverted));
    }
    return child;
  });
}

export function MarkdownContent({ source, inverted = false }: { source: string; inverted?: boolean }): JSX.Element {
  return (
    <div className={cn("min-w-0 break-words text-sm leading-relaxed", inverted ? "text-on-accent" : "text-ink")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
        p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{renderWithFileRefs(children, inverted)}</p>,
        h1: ({ children }) => <h1 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0">{children}</h3>,
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
        li: ({ children }) => <li>{renderWithFileRefs(children, inverted)}</li>,
        blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-accent/50 pl-3 text-ink-2">{children}</blockquote>,
        a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">{children}</a>,
        code: ({ children, className }) => {
          if (className) return <code className={cn("font-mono text-[12px]", className)}>{children}</code>;
          const reference = parseFileReference(textOf(children));
          if (reference) return <FileRefChip reference={reference} label={textOf(children)} inverted={inverted} />;
          return <code className={cn("rounded px-1.5 py-0.5 font-mono text-[12px]", inverted ? "bg-white/15" : "bg-card-hover text-accent")}>{children}</code>;
        },
        pre: ({ children }) => <pre className="my-2 max-w-full overflow-auto rounded-xl border border-line bg-card-hover p-3 font-mono text-[12px] leading-relaxed text-ink-2">{children}</pre>,
        table: ({ children }) => <table className="my-3 w-full border-collapse overflow-hidden text-left text-[12px]">{children}</table>,
        th: ({ children }) => <th className="border border-line bg-card-hover px-2.5 py-2 font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-line px-2.5 py-2 align-top">{renderWithFileRefs(children, inverted)}</td>,
        hr: () => <hr className="my-4 border-line" />,
        img: ({ src, alt }) => typeof src === "string"
          ? <TimelineImage src={src} alt={alt ?? ""} className="my-2 max-h-72 max-w-full rounded-xl border border-line object-contain" />
          : null
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
