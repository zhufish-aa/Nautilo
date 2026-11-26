import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeMarkdownLocalLinks } from "./file-references";

/** This partitions the *parsed tree*, never Markdown source. Definitions,
 * fences, tables, lists and footnotes are resolved against the whole document
 * first, so references added at the end can update an earlier fragment. */
const NODES_PER_FRAGMENT = 64;

export type MarkdownNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  position?: { start: { line: number } };
  children?: MarkdownNode[];
};

function parseMarkdown(source: string): MarkdownNode[] {
  let nodes: MarkdownNode[] = [];
  ReactMarkdown({
    children: normalizeMarkdownLocalLinks(source),
    remarkPlugins: [remarkGfm],
    rehypePlugins: [() => (tree: unknown) => {
      nodes = (tree as { children: MarkdownNode[] }).children;
      // Capture through ReactMarkdown's public plugin API, avoiding a second
      // parser/configuration that could drift from the synchronous fallback.
      // Rendering/safe URL transforms happen in ReactMarkdown on the UI side.
      return { type: "root", children: [] };
    }]
  });
  return nodes;
}

function serialize(children: MarkdownNode[]): string {
  return JSON.stringify({ type: "root", children }, (key, value: unknown) => key === "position" ? undefined : value);
}

export function parseMarkdownFragments(source: string, blockwise = false): string[] {
  if (blockwise) return parseMarkdownBlocks(source).map(block => block.serialized);
  const nodes = parseMarkdown(source);
  const fragments: string[] = [];
  for (let index = 0; index < nodes.length; index += NODES_PER_FRAGMENT) {
    fragments.push(serialize(nodes.slice(index, index + NODES_PER_FRAGMENT)));
  }
  return fragments;
}

export function parseMarkdownBlocks(source: string, live = false) {
  // Huge open fences are already known to be literal text. Avoid sending
  // their entire body through the lexer for each new character.
  if (live && source.length >= 2_000) {
    const opening = source.match(/^(`{3,}|~{3,})[ \t]*([\w.+-]*)[ \t]*\r?\n/);
    if (opening) {
      const marker = opening[1];
      const body = source.slice(opening[0].length);
      const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*\\r?$`, "m");
      if (!close.test(body) && !body.includes("](")) {
        const value = body.replace(/\r?\n$/, "");
        const properties = opening[2] ? { className: [`language-${opening[2]}`] } : {};
        return [{ line: 1, serialized: serialize([{ type: "element", tagName: "pre", properties: {}, children: [
          { type: "element", tagName: "code", properties, children: value ? [{ type: "text", value: value + "\n" }] : [] }
        ] }]) }];
      }
    }
  }
  let nodes = parseMarkdown(source);
  let tail = nodes.at(-1);
  while (tail?.tagName && /^(ul|ol|li|blockquote)$/.test(tail.tagName)) {
    const children = tail.children ?? [];
    let index = children.length - 1;
    while (index >= 0 && children[index].type === "text" && !children[index].value?.trim()) index--;
    if (children[index]?.type !== "element") break;
    tail = children[index];
  }
  if (live && (tail?.tagName === "p" || tail?.tagName === "li")) {
    const trimmed = source.trimEnd();
    const line = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
    let code = "";
    let bold = false;
    let lastOpener = -1;
    for (const match of line.matchAll(/(?<![\\`*])(`+|\*\*(?!\*))/g)) {
      const token = match[0];
      if (token[0] === "`") {
        if (code === token) code = "";
        else if (!code) { code = token; lastOpener = match.index; }
      } else if (!code) {
        bold = !bold;
        if (bold) lastOpener = match.index;
      }
    }
    const close = code + (bold ? "**" : "");
    if (close) {
      // A synthetic closer is for display only. Keep a bare opener hidden
      // while its first word is still arriving.
      const trailing = line.match(/(?:`+|\*+)$/)?.[0];
      const partial = trailing && close.startsWith(trailing) ? trailing.length : 0;
      const bare = partial > 0 && lastOpener === line.length - partial;
      const preview = trimmed.slice(0, trimmed.length - partial) + (bare ? "" : close) + source.slice(trimmed.length);
      nodes = parseMarkdown(preview);
    }
  }
  return nodes.filter(node => node.type !== "text" || node.value?.trim()).map(node => ({
    line: node.position?.start.line,
    serialized: serialize([node])
  }));
}
