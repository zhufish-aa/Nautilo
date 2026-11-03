import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeMarkdownLocalLinks } from "./file-references";

/** This partitions the *parsed tree*, never Markdown source. Definitions,
 * fences, tables, lists and footnotes are resolved against the whole document
 * first, so references added at the end can update an earlier fragment. */
const NODES_PER_FRAGMENT = 64;

export function parseMarkdownFragments(source: string): string[] {
  const fragments: string[] = [];
  ReactMarkdown({
    children: normalizeMarkdownLocalLinks(source),
    remarkPlugins: [remarkGfm],
    rehypePlugins: [() => (tree: unknown) => {
      const children = (tree as { children: unknown[] }).children;
      for (let index = 0; index < children.length; index += NODES_PER_FRAGMENT) {
        // Positions are parser metadata, not rendered content. Dropping them
        // permits exact equality/reuse when only a later block changes, and
        // substantially reduces worker structured-clone traffic.
        fragments.push(JSON.stringify({ type: "root", children: children.slice(index, index + NODES_PER_FRAGMENT) }, (key, value: unknown) => key === "position" ? undefined : value));
      }
      // Capture through ReactMarkdown's public plugin API, avoiding a second
      // parser/configuration that could drift from the synchronous fallback.
      // Rendering/safe URL transforms happen in ReactMarkdown on the UI side.
      return { type: "root", children: [] };
    }]
  });
  return fragments;
}
