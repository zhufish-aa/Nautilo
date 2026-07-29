import { useMemo } from "react";
import type { ToolFileDiff } from "@agenthub/event-protocol";
import { diffLines, type DiffRow } from "../../lib/line-diff";
import { highlightLine, languageForPath } from "../../lib/highlight";
import { cn } from "../../lib/utils";

/** One syntax-highlighted text fragment (line or intra-line segment). */
function Highlighted({ text, language, className }: {
  text: string;
  language?: string;
  className?: string;
}): JSX.Element {
  const html = useMemo(() => highlightLine(text, language), [text, language]);
  // eslint-disable-next-line react/no-danger -- html is escaped/built by highlight.js
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

function DiffRowView({ row, language }: { row: DiffRow; language?: string }): JSX.Element {
  if (row.type === "same") {
    return (
      <div className="flex text-ink-2/80">
        <span className="w-7 shrink-0 select-none px-2 text-right opacity-50">&nbsp;</span>
        <Highlighted text={row.text} language={language} className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3" />
      </div>
    );
  }
  const removed = row.type === "removed";
  const hasInline = row.segments.some((segment) => segment.changed);
  return (
    <div className={cn("flex text-ink", removed ? "bg-danger/10" : "bg-ok/10")}>
      <span className={cn("w-7 shrink-0 select-none px-2 text-right", removed ? "text-danger" : "text-ok")}>
        {removed ? "-" : "+"}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3">
        {row.text === ""
          ? " "
          : hasInline
            ? row.segments.map((segment, index) => (
              <Highlighted
                key={index}
                text={segment.text}
                language={language}
                className={segment.changed
                  ? cn("rounded-[3px] box-decoration-clone px-px -mx-px", removed ? "bg-danger/30" : "bg-ok/30")
                  : undefined}
              />
            ))
            : <Highlighted text={row.text} language={language} />}
      </span>
    </div>
  );
}

export function ToolFileDiffView({ diff, locale, scrollClassName = "max-h-72" }: {
  diff: ToolFileDiff;
  locale: "zh-CN" | "en-US";
  /** Overrides the scroll container constraint (e.g. "max-h-none" in drawers). */
  scrollClassName?: string;
}): JSX.Element {
  const removed = diff.before ? diff.before.split(/\r?\n/).length : 0;
  const added = diff.after ? diff.after.split(/\r?\n/).length : 0;
  const rows = useMemo(() => diffLines(diff.before, diff.after), [diff.before, diff.after]);
  const language = languageForPath(diff.path);
  const title = diff.operation === "write"
    ? (locale === "zh-CN" ? "写入内容" : "Written content")
    : (locale === "zh-CN" ? "修改内容" : "Changes");
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[11px]">
        <span className="font-medium text-ink-2">{title}</span>
        {removed > 0 && <span className="text-danger">-{removed}</span>}
        <span className="text-ok">+{added}</span>
        {diff.truncated && (
          <span className="ml-auto text-warn">{locale === "zh-CN" ? "内容过长，已截断" : "Long diff truncated"}</span>
        )}
      </div>
      <div className={`${scrollClassName} overflow-auto py-1 font-mono text-[11px] leading-relaxed`}>
        {rows.map((row, index) => <DiffRowView key={index} row={row} language={language} />)}
      </div>
    </div>
  );
}
