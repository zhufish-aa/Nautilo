import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";

export function MarkdownContent({ source, inverted = false }: { source: string; inverted?: boolean }): JSX.Element {
  return (
    <div className={cn("min-w-0 break-words text-sm leading-relaxed", inverted ? "text-on-accent" : "text-ink")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
        p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
        h1: ({ children }) => <h1 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0">{children}</h3>,
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
        blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-accent/50 pl-3 text-ink-2">{children}</blockquote>,
        a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">{children}</a>,
        code: ({ children, className }) => className
          ? <code className={cn("font-mono text-[12px]", className)}>{children}</code>
          : <code className={cn("rounded px-1.5 py-0.5 font-mono text-[12px]", inverted ? "bg-white/15" : "bg-card-hover text-accent")}>{children}</code>,
        pre: ({ children }) => <pre className="my-2 max-w-full overflow-auto rounded-xl border border-line bg-card-hover p-3 font-mono text-[12px] leading-relaxed text-ink-2">{children}</pre>,
        table: ({ children }) => <table className="my-3 w-full border-collapse overflow-hidden text-left text-[12px]">{children}</table>,
        th: ({ children }) => <th className="border border-line bg-card-hover px-2.5 py-2 font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-line px-2.5 py-2 align-top">{children}</td>,
        hr: () => <hr className="my-4 border-line" />
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
