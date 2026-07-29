import type { SkillCandidate } from "@agenthub/schemas";
import { SKILL_FILE_MARKER } from "../capability-service.js";

/** Core Daemon provider ids a skill's frontmatter may target. */
const KNOWN_PROVIDERS = new Set(["codex", "kimi-code", "claude-code", "opencode", "custom"]);

/** Frontmatter keys we understand; everything else is surfaced as a warning. */
const KNOWN_KEYS = new Set([
  "name",
  "title",
  "description",
  "summary",
  "tags",
  "keywords",
  "source",
  "enabled",
  "providers",
  "provider"
]);

const MARKER = new RegExp(`^\\s*<!--\\s*${SKILL_FILE_MARKER}([^\\s>]+)\\s*-->\\s*$`, "m");

interface Frontmatter {
  fields: Map<string, string | string[]>;
  unknown: string[];
}

/**
 * Reads the small YAML subset skill files actually use: `key: value`, inline
 * `[a, b]` lists, and block lists written as `- item` on following lines.
 */
function parseFrontmatter(block: string): Frontmatter {
  const fields = new Map<string, string | string[]>();
  const unknown: string[] = [];
  const lines = block.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const key = match[1].toLowerCase();
    let raw = match[2].trim();

    if (!raw) {
      // A block list: consume the following `- item` lines.
      const items: string[] = [];
      while (index + 1 < lines.length && /^\s*-\s+/.test(lines[index + 1])) {
        index += 1;
        items.push(stripQuotes(lines[index].replace(/^\s*-\s+/, "").trim()));
      }
      if (items.length > 0) {
        fields.set(key, items.filter(Boolean));
        // Report the key as the user spelled it, so it can be found in the file.
        if (!KNOWN_KEYS.has(key)) unknown.push(match[1]);
        continue;
      }
    }

    if (raw.startsWith("[") && raw.endsWith("]")) {
      fields.set(key, raw.slice(1, -1).split(",").map((item) => stripQuotes(item.trim())).filter(Boolean));
    } else {
      raw = stripQuotes(raw);
      if (raw) fields.set(key, raw);
    }
    if (!KNOWN_KEYS.has(key)) unknown.push(match[1]);
  }
  return { fields, unknown };
}

function stripQuotes(value: string): string {
  return value.replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
}

function asList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function asText(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

/** First non-heading, non-empty paragraph — the usual "what is this" line. */
function firstParagraph(body: string): string {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block.trim();
    if (!text || text.startsWith("#") || text.startsWith("<!--")) continue;
    return text.replace(/\s+/g, " ").slice(0, 240);
  }
  return "";
}

function firstHeading(body: string): string | undefined {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
}

function buildCandidate(
  frontmatter: Frontmatter | undefined,
  body: string,
  fallbackName: string,
  origin?: string
): SkillCandidate | undefined {
  const warnings: string[] = [];
  let instructions = body.trim();

  // Strip our own provenance marker so re-imported files stay clean.
  const marker = MARKER.exec(instructions);
  const existingId = marker?.[1];
  if (marker) instructions = instructions.replace(MARKER, "").trim();
  if (!instructions) return undefined;

  const fields = frontmatter?.fields ?? new Map<string, string | string[]>();
  if (frontmatter && frontmatter.unknown.length > 0) {
    warnings.push(`未识别的 frontmatter 字段：${frontmatter.unknown.join("、")}`);
  }

  const providerIds = asList(fields.get("providers") ?? fields.get("provider")).filter((id) => {
    if (KNOWN_PROVIDERS.has(id)) return true;
    warnings.push(`未知的 provider "${id}"，已忽略`);
    return false;
  });

  const name = asText(fields.get("name") ?? fields.get("title")) ?? firstHeading(instructions) ?? fallbackName;
  const description = asText(fields.get("description") ?? fields.get("summary")) ?? firstParagraph(instructions);
  if (!description) warnings.push("未找到描述，建议补充");

  return {
    name: name.trim(),
    description: description.trim(),
    tags: asList(fields.get("tags") ?? fields.get("keywords")),
    instructions,
    ...(asText(fields.get("source")) ? { source: asText(fields.get("source")) } : {}),
    enabled: String(fields.get("enabled") ?? "true").toLowerCase() !== "false",
    providerIds,
    warnings,
    ...(origin ? { origin } : {}),
    ...(existingId ? { existingId } : {})
  };
}

/** Locates every line-start `---` fence pair in the document. */
function findFrontmatterBlocks(text: string): Array<{ start: number; bodyStart: number; block: string }> {
  const blocks: Array<{ start: number; bodyStart: number; block: string }> = [];
  const fence = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/gm;
  let match = fence.exec(text);
  while (match) {
    blocks.push({ start: match.index, bodyStart: match.index + match[0].length, block: match[1] });
    fence.lastIndex = match.index + match[0].length;
    match = fence.exec(text);
  }
  return blocks;
}

/**
 * Turns a skill Markdown file into one or more candidates.
 *
 * Splitting rules, in order:
 *  1. Every line-start YAML frontmatter fence starts a new skill; its body runs
 *     to the next fence or EOF. This is how one `skills.md` can hold many.
 *  2. No frontmatter but two or more `# ` H1 headings: split on the headings.
 *  3. Otherwise the whole file is a single skill.
 */
export function parseSkillMarkdown(
  text: string,
  fallbackName = "skill",
  origin?: string
): { skills: SkillCandidate[]; errors: string[] } {
  if (!text.trim()) return { skills: [], errors: [] };

  const blocks = findFrontmatterBlocks(text);
  const skills: SkillCandidate[] = [];

  if (blocks.length > 0) {
    // Content before the first fence is a preamble, not a skill.
    blocks.forEach((entry, index) => {
      const end = index + 1 < blocks.length ? blocks[index + 1].start : text.length;
      const body = text.slice(entry.bodyStart, end);
      const candidate = buildCandidate(
        parseFrontmatter(entry.block),
        body,
        blocks.length > 1 ? `${fallbackName}-${index + 1}` : fallbackName,
        origin
      );
      if (candidate) skills.push(candidate);
    });
    return skills.length > 0
      ? { skills, errors: [] }
      : { skills, errors: ["识别到 frontmatter，但没有正文内容"] };
  }

  const headings = [...text.matchAll(/^#\s+.+$/gm)];
  if (headings.length >= 2) {
    headings.forEach((heading, index) => {
      const start = heading.index ?? 0;
      const end = index + 1 < headings.length ? (headings[index + 1].index ?? text.length) : text.length;
      const candidate = buildCandidate(undefined, text.slice(start, end), `${fallbackName}-${index + 1}`, origin);
      if (candidate) skills.push(candidate);
    });
    return { skills, errors: [] };
  }

  const single = buildCandidate(undefined, text, fallbackName, origin);
  return single ? { skills: [single], errors: [] } : { skills: [], errors: ["文件没有可用内容"] };
}
