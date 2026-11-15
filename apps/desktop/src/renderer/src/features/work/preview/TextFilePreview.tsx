import { useMemo } from "react";
import { highlightCode, languageForPath } from "../../../lib/highlight";
import { VirtualizedCode } from "../../timeline/FilePreviewDrawer";

export function TextFilePreview({ text, path }: { text: string; path: string }): JSX.Element {
  const lines = useMemo(() => text.replace(/\r\n?/g, "\n").split("\n"), [text]);
  const large = text.length > 200_000 || lines.length > 3_000;
  const html = useMemo(() => large ? "" : highlightCode(text, path), [text, path, large]);
  if (large) return <VirtualizedCode lines={lines} language={languageForPath(path)} />;
  return (
    <div className="h-full overflow-auto">
      <pre className="min-h-full whitespace-pre-wrap break-words bg-card/40 px-5 py-4 font-mono text-[12px] leading-5 text-ink-2">
        {/* highlightCode escapes all source text before emitting token spans. */}
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}
