import { parseMarkdownBlocks, type MarkdownNode } from "./markdown-parse";
import { splitTextByFileReferences } from "./file-references";
import { streamGraphemes } from "./streaming-text";

export type StreamingMarkdown = {
  source: string;
  offset: number;
  fixed: readonly string[];
  tail: readonly string[];
};

export function updateStreamingMarkdown(previous: StreamingMarkdown | undefined, source: string, streaming: boolean): StreamingMarkdown {
  const compatible = previous && source.startsWith(previous.source) ? previous : undefined;
  const offset = compatible?.offset ?? 0;
  const fixed = compatible?.fixed ?? [];
  const tailSource = source.slice(offset);
  const blocks = parseMarkdownBlocks(tailSource, streaming);
  const lastLine = blocks.at(-1)?.line;
  if (blocks.length > 1 && lastLine && lastLine > 1 && blocks.slice(0, -1).every(block => block.line && block.line < lastLine)) {
    // Coordinates use lines so Windows link normalization cannot change a
    // source boundary. Wait for the next block's first line to be complete.
    let start = 0;
    for (let line = 1; line < lastLine; line++) start = tailSource.indexOf("\n", start) + 1;
    if (tailSource.indexOf("\n", start) >= 0) {
      return { source, offset: offset + start, fixed: [...fixed, ...blocks.slice(0, -1).map(block => block.serialized)], tail: [blocks.at(-1)!.serialized] };
    }
  }
  return { source, offset, fixed, tail: blocks.map(block => block.serialized) };
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Decorate the active tree only. Stable inline spans use the same positions
 * whenever the existing text stays put. Leave file references to the app's
 * existing path renderer and fenced code to its copy/highlighting component. */
export function decorateStreamText(root: MarkdownNode, seen: number): number {
  let offset = 0;
  function visit(node: MarkdownNode): void {
    if (!node.children || node.tagName === "pre") return;
    node.children = node.children.flatMap((child) => {
      if (child.type !== "text" || !child.value) {
        visit(child);
        return [child];
      }
      const text = child.value;
      if (!text.trim() || ((text.includes("/") || text.includes("\\")) && splitTextByFileReferences(text).some(part => part.kind !== "text"))) {
        offset += text.length;
        return [child];
      }
      const spans: MarkdownNode[] = [];
      let segment = "";
      let count = 0;
      let cjk = false;
      const flush = () => {
        if (!segment) return;
        spans.push({ type: "element", tagName: "span",
          properties: { dataStreamSegment: true, dataStreamNew: offset >= seen },
          children: [{ type: "text", value: segment }] });
        offset += segment.length;
        segment = "";
        count = 0;
      };
      for (const grapheme of streamGraphemes(text)) {
        if (/^\s+$/u.test(grapheme)) {
          if (segment) { segment += grapheme; flush(); }
          else { spans.push({ type: "text", value: grapheme }); offset += grapheme.length; }
          continue;
        }
        const nextCjk = CJK.test(grapheme);
        if (count && (cjk !== nextCjk || count >= (cjk ? 2 : 24))) flush();
        cjk = nextCjk;
        segment += grapheme;
        count++;
      }
      flush();
      return spans;
    });
  }
  visit(root);
  return offset;
}
