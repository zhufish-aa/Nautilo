import { parseDocument } from "yaml";

/** A display-only reading of the first Markdown header. The import preview still comes from Core. */
export function skillStructure(text: string) {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(text);
  let body = text;
  let fields: Record<string, unknown> = {};
  let invalid = false;
  if (opening) {
    const remainder = text.slice(opening[0].length);
    const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(remainder);
    body = closing ? remainder.slice(closing.index + closing[0].length) : "";
    invalid = !closing || closing.index > 64 * 1024;
    if (closing && !invalid) {
      try {
        const doc = parseDocument(remainder.slice(0, closing.index), { logLevel: "silent" });
        invalid = doc.errors.length > 0;
        if (!invalid) {
          const parsed: unknown = doc.toJS({ maxAliasCount: 0 });
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
        }
      } catch {
        invalid = true;
      }
    }
  }
  const value = (field: unknown): string => typeof field === "string" ? field.trim() : "";
  const tags = fields.tags ?? fields.keywords;
  const content = body.trim();
  return {
    name: value(fields.name ?? fields.title),
    description: value(fields.description ?? fields.summary),
    tags: (Array.isArray(tags) ? tags.map(value) : value(tags).split(",").map(tag => tag.trim())).filter(Boolean),
    lines: content ? content.split(/\r\n|\n|\r/).length : 0,
    characters: content.length,
    invalid,
  };
}
