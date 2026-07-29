/** Prompt snippet library ("//" in the composer inserts a saved prompt). */

export interface PromptSnippet {
  id: string;
  title: string;
  text: string;
}

/** `//foo` at the very start of the composer (no whitespace yet) queries snippets. */
export function snippetQuery(value: string): string | undefined {
  return /^\/\/[^\s]*$/.test(value) ? value.slice(2).toLowerCase() : undefined;
}

export function filterSnippets(snippets: PromptSnippet[], query: string): PromptSnippet[] {
  if (!query) return snippets;
  return snippets.filter((snippet) =>
    snippet.title.toLowerCase().includes(query) || snippet.text.toLowerCase().includes(query)
  );
}
