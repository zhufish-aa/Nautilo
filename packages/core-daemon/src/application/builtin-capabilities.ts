import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderCapability } from "@agenthub/domain";
import type { CapabilityService } from "./capability-service.js";
import { BUILTIN_SKILL_SCRIPTS } from "./builtin-skill-scripts.js";
import { LEGACY_BODIES } from "./builtin-skill-legacy.js";

/**
 * Built-in office skill pack, seeded for Work mode. Production-grade shape:
 * instructions + a bundled Python toolchain (render/verify, scaffolds, xlsx
 * build) materialized under <dataDir>/builtin-skills and mirrored next to each
 * provider's SKILL.md via SkillFileSync's resourceDir mechanism.
 *
 * Seeding is lazy (first capability.list) and idempotent:
 * - missing ids are created;
 * - untouched v1 bodies (prefix match) and untouched v2 bodies (exact match
 *   against builtin-skill-legacy.ts) are upgraded in place — user edits,
 *   enabled and providerIds are always preserved;
 * - anything the user edited or disabled is left untouched.
 */

const COMMON_RULES = `
## Environment rules
- Work inside the session workspace directory. Never touch files outside it.
- Third-party Python packages go into an isolated environment (\`python -m venv .venv\` in the workspace), never the system Python. The bundled scripts print the exact setup command when a dependency is missing.
- Verify before you report: run \`inspect\` (and \`render\` when LibreOffice is available) and fix every issue it finds. Never claim quality without evidence.
- End your reply with the exact path of every deliverable you created or updated.
`.trim();

const DOCUMENTS = `
# Office Documents (.docx) — script-first workflow

Produce professional Word documents. The bundled scripts next to this SKILL.md are the primary toolchain — use them instead of improvising.

## Toolchain
- \`python scripts/office_scaffold.py docx out.docx --title "..." [--subtitle "..."] [--accent 305496] [--latin-font Calibri] [--cjk-font "Microsoft YaHei"] [--cover] [--toc]\` — styled skeleton: Normal + Heading 1-3 fonts (Latin & CJK), margins, running header, footer page numbers; optional cover page and a real TOC field. Colors and fonts are YOURS — pass the flags, there are no built-in themes. Always start from this, never from a blank Document().
- \`python scripts/render_verify.py inspect out.docx\` — structural audit as JSON: heading outline order, duplicate headings, table dimensions and empty header rows, image count, TOC presence, margins, placeholder text. Exit code 1 = findings to fix.
- \`python scripts/render_verify.py render out.docx [--out rendered]\` — LibreOffice converts to PDF; page PNGs when pdftoppm is available. Use it to prove the file opens in a real Office app.

## Writing the content
- Fill the scaffold with python-docx: heading levels in order (they drive the navigation pane), consistent terminology, no filler text.
- Reusable helpers (add the scripts directory to sys.path, then \`from office_scaffold import ...\`):
  - \`style_docx(doc)\`, \`add_docx_header(doc, title)\`, \`add_docx_footer_pagenum(doc)\`, \`add_toc(doc)\`
  - \`add_table(doc, rows, header=True)\` — accent header row, banded rows, thin grid. Use it for all tabular data.
  - \`add_image(doc, path, width_in=6.0, caption="...")\` — centered image with auto-numbered Figure caption.
  - \`add_callout(doc, text, kind="note|warning|tip")\` — shaded callout block.
  - \`add_code(doc, text)\` — monospace shaded code block.
- Long reports: --cover + --toc, then Heading 1 per section. Remind the user to update the TOC field (F9) after opening.

## Done means
1. \`inspect\` passes with zero issues.
2. \`render\` succeeded (or LibreOffice is confirmed absent — say so).
3. The reply ends with the absolute path of the .docx.
`.trim();

const SPREADSHEETS = `
# Office Spreadsheets (.xlsx) — script-first workflow

Produce professional Excel workbooks with openpyxl. The bundled scripts next to this SKILL.md are the primary toolchain.

## Toolchain
- \`python scripts/xlsx_build.py new out.xlsx --sheets Data,Summary\` — workbook with the sheet structure.
- \`python scripts/xlsx_build.py import-csv in.csv out.xlsx [--sheet Data]\` — CSV import with type inference, already styled.
- Write data with openpyxl: header row first, raw data untouched on its own sheet, analysis on separate sheets referencing it. Use real Excel formulas (SUM, ratios) for computed columns so the workbook stays live.
- \`python scripts/xlsx_build.py style out.xlsx [--formats B:currency,C:percent,D:date] [--databar E]\` — header fill + bold white text, frozen top row, autofilter, content-sized columns, number-format presets, conditional data bars. Never ship raw floats in presentation sheets.
- \`python scripts/xlsx_build.py add-chart out.xlsx --sheet Data --type bar|line|pie --data A1:B10 --title "..."\` — native chart (categories in the first column of the range). Add charts AFTER all other edits: openpyxl round-trips drop existing charts.
- \`python scripts/xlsx_build.py verify out.xlsx\` — JSON report: sheet dims, freeze/filter state, formulas with cached values, blank rows, merged cells, format coverage, chart count. Exit code 1 = findings.
- \`python scripts/render_verify.py render out.xlsx\` — optional LibreOffice smoke test proving the file opens.

## Data quality
- Cross-check a sample of formula results in Python against the inputs before shipping.
- Charts for trends and comparisons; place them beside the data (default anchor H2).

## Done means
1. \`verify\` passes with zero issues (formulas carry cached values or you explain why).
2. The reply ends with the absolute path of the .xlsx.
`.trim();

const PRESENTATIONS = `
# Office Presentations (.pptx) — script-first workflow

Produce professional 16:9 slide decks with python-pptx. The bundled scripts next to this SKILL.md are the primary toolchain. Decks should look DESIGNED, not default — and the design is YOURS: the scripts ship zero built-in themes. You compose the look from style tokens, exactly like writing CSS.

## Style tokens (the CSS of the deck)
- \`accent\` (brand color) · \`bg\` + \`bgTo\` (solid or gradient background) · \`glow\` (soft accent-halo background PNG, needs pillow) · \`surface\` (card/table fill) · \`ink\` (primary text) · \`muted\` (secondary text) · \`latin\` / \`cjk\` fonts.
- CLI: \`python scripts/office_scaffold.py pptx out.pptx --title "..." --accent 35C4DC --bg 0B1D33 --bg-to 06101C --glow --ink F2F7FA --muted 9FB3C8 --surface 13304A\`
- API: \`set_style(accent="35C4DC", bg="0B1D33", bgTo="06101C", glow=True, ink="F2F7FA", muted="9FB3C8", surface="13304A")\`
- Display type and chart fonts auto-adapt to background luminance; pick bg first, then ink/muted with enough contrast.
- Recipes are starting points, not presets — mix freely: keynote dark (tokens above) · clean light (accent 305496, bg FFFFFF, surface F2F5FA, ink 1F1F1F, muted 595959 — the default) · warm paper (accent B4552D, bg FDF9F3, surface F5EDE2, ink 2E2A26, muted 7A7066).

## Layout library (import from office_scaffold)
- \`add_title_slide(prs, title, subtitle, kicker=..., footer=...)\` / \`add_section_slide(prs, title, kicker="PART 01")\` / \`add_closing_slide(prs, ..., footer=...)\`
- \`add_agenda_slide(prs, items)\` — big accent numerals with hairline dividers.
- \`add_cards_slide(prs, title, [("01", "Heading", "description"), ...], kicker=...)\` — rounded cards; the workhorse layout for features/pillars/options. 2-4 cards per slide.
- \`add_stats_slide(prs, title, [("98%", "uptime"), ...])\` — big-number callouts.
- \`add_content_slide(prs, title, [(0, "point"), (1, "detail")])\` — bullets, levels 0-2, enforced type hierarchy (24pt title / 18-14pt body).
- \`add_two_column_slide(prs, title, left, right)\` — two bullet columns.
- \`add_table_slide(prs, title, rows)\` — styled table, accent header row.
- \`add_image_slide(prs, title, image_path, caption)\` — full-width image + caption.
- \`add_chart_slide(prs, title, categories, [("Series", (v1, v2, ...))], "bar|line|pie")\` — native editable chart, series colored from your accent.
- \`add_quote_slide(prs, quote, attribution)\` — big quotation.
- \`add_kicker(slide, text)\` / \`add_footer(slide, text, number)\` — slide furniture for a consistent frame.
- \`set_speaker_notes(slide, text)\` — required on slides carrying numbers or charts.
- \`python scripts/office_scaffold.py pptx out.pptx --title "..." --demo [tokens]\` renders one sample of every layout in YOUR tokens — use it as a style preview before writing real content.

## Verification
- \`python scripts/render_verify.py inspect out.pptx\` — JSON audit per slide: char budgets, overflow estimates, sub-10pt fonts, empty slides, chart slides missing notes, font-family sprawl. Exit code 1 = findings.
- \`python scripts/render_verify.py render out.pptx [--out rendered]\` — LibreOffice → PDF (+ page PNGs with pdftoppm). Review the images yourself when available.

## Design rules
- One message per slide; ~8-15 slides; max ~6 bullet lines per slide; title 24-40pt, body ≥ 14pt.
- Narrative order: title → agenda → section dividers → content → conclusion. Vary the layout: cards for parallel points, stats for numbers, table/chart for data, quote for transitions — never three bullet slides in a row.
- Keep the frame consistent: kicker + title top-left, footer with deck name and page number on content slides, one accent color everywhere.

## Done means
1. \`inspect\` passes with zero issues.
2. \`render\` succeeded (or LibreOffice is confirmed absent — say so).
3. The reply ends with the absolute path of the .pptx.
`.trim();

const RESEARCH = `
# Research Reports — evidence-first workflow

Produce structured, source-backed research reports (Markdown source, optional .docx export).

## Workflow
1. Decompose the question into 3-7 sub-questions; gather evidence for each before writing.
2. Structure: executive summary first (half a page, answer-first), findings per sub-question, comparison/recommendation, sources.
3. Every non-obvious claim carries a source (URL + what it supports). Mark anything unverifiable as "unverified" — never state it as fact, never invent a URL.
4. Tables for comparisons; tight prose — a report is read for its conclusions.

## Export & verification
- Deliver the .md file. For .docx: \`python scripts/office_scaffold.py docx report.docx --title "..." --cover --toc\` then fill it with python-docx (use add_table for comparison matrices) or convert with pandoc.
- \`python scripts/render_verify.py inspect report.docx\` before shipping any .docx.
- Confirm every cited URL actually appeared in your gathered evidence, and that the summary answers the original question in isolation.
`.trim();

const BUILTIN_PROVIDER_IDS = ["kimi-code", "claude-code", "codex"];
const BUILTIN_VERSION_TAG = "builtin-v5";

/** First line of each v1 body: used to upgrade only untouched v1 installs. */
const V1_BODY_PREFIX: Record<string, string> = {
  "builtin-office-documents": "# Office Documents (.docx)\n\nProduce professional Word documents",
  "builtin-office-spreadsheets": "# Office Spreadsheets (.xlsx)\n\nProduce professional Excel workbooks",
  "builtin-office-presentations": "# Office Presentations (.pptx)\n\nProduce professional slide decks",
  "builtin-office-research": "# Research Reports\n\nProduce structured research reports"
};

function skill(id: string, name: string, description: string, instructions: string): ProviderCapability {
  return {
    id,
    kind: "skill",
    name,
    description,
    tags: ["office", "builtin", BUILTIN_VERSION_TAG],
    enabled: true,
    providerIds: [...BUILTIN_PROVIDER_IDS],
    skill: { instructions: `${instructions}\n\n${COMMON_RULES}`, source: "Built-in" },
    createdAt: "",
    updatedAt: ""
  };
}

export const BUILTIN_OFFICE_SKILLS: ProviderCapability[] = [
  skill(
    "builtin-office-documents",
    "Office Documents",
    "Create and edit professional .docx Word documents — cover pages, TOC fields, styled tables and figures, structural audits, LibreOffice render checks.",
    DOCUMENTS
  ),
  skill(
    "builtin-office-spreadsheets",
    "Office Spreadsheets",
    "Create and edit professional .xlsx Excel workbooks — CSV import, live formulas, number-format presets, data bars, native charts, formula cross-verification.",
    SPREADSHEETS
  ),
  skill(
    "builtin-office-presentations",
    "Office Presentations",
    "Create and edit professional .pptx slide decks — full layout library (agenda, cards, stats, table, image, chart, quote), CSS-like style tokens instead of baked-in themes, speaker notes, render-and-review checks.",
    PRESENTATIONS
  ),
  skill(
    "builtin-office-research",
    "Research Reports",
    "Write structured, source-backed research reports in Markdown with verified .docx export.",
    RESEARCH
  )
];

/**
 * Writes the bundled Python toolchain to <resourceRoot>/<slug>/scripts/ and
 * returns each capability id's resourceDir. Files are refreshed on every call
 * — they are app-owned, and updates should reach already-seeded installs.
 */
export function materializeBuiltinSkillResources(resourceRoot: string): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const [capabilityId, files] of Object.entries(BUILTIN_SKILL_SCRIPTS)) {
    const dir = join(resourceRoot, capabilityId.replace(/^builtin-/, ""));
    for (const [relativePath, content] of Object.entries(files)) {
      const target = join(dir, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    dirs.set(capabilityId, dir);
  }
  return dirs;
}

/** True only when the stored body is a byte-exact, never-touched earlier release. */
function isUntouchedUpgradeCandidate(current: ProviderCapability, capabilityId: string): boolean {
  if (current.skill?.source !== "Built-in") {
    return false;
  }
  const instructions = current.skill.instructions;
  if (LEGACY_BODIES[capabilityId]?.includes(instructions)) {
    return true; // exact match against a shipped v2/v3 body — no user edits
  }
  const v1Prefix = V1_BODY_PREFIX[capabilityId];
  return Boolean(v1Prefix)
    && !current.tags.some((tag) => /^builtin-v\d+$/.test(tag))
    && instructions.startsWith(v1Prefix);
}

/**
 * Creates missing built-ins and upgrades untouched v1/v2 installs. User-edited
 * or user-disabled entries are never overwritten; enabled/providerIds survive
 * upgrades. When resourceRoot is given, the bundled scripts are (re)written
 * and each capability points at them via skill.resourceDir.
 */
export function seedBuiltinCapabilities(capabilities: CapabilityService, resourceRoot?: string): { seeded: number; upgraded: number } {
  const resourceDirs = resourceRoot ? materializeBuiltinSkillResources(resourceRoot) : undefined;
  const existing = new Map(capabilities.list().map((capability) => [capability.id, capability]));
  let seeded = 0;
  let upgraded = 0;
  for (const capability of BUILTIN_OFFICE_SKILLS) {
    const withResources: ProviderCapability = resourceDirs
      ? { ...capability, skill: { ...capability.skill!, resourceDir: resourceDirs.get(capability.id) } }
      : capability;
    const current = existing.get(capability.id);
    if (!current) {
      capabilities.upsert(withResources);
      seeded += 1;
      continue;
    }
    const needsResources = Boolean(resourceDirs) && current.skill?.resourceDir !== resourceDirs?.get(capability.id);
    const isCurrentV3 = current.skill?.source === "Built-in" && current.tags.includes(BUILTIN_VERSION_TAG);
    if (isUntouchedUpgradeCandidate(current, capability.id) || (isCurrentV3 && needsResources)) {
      capabilities.upsert({
        ...withResources,
        enabled: current.enabled,
        providerIds: current.providerIds.length ? current.providerIds : withResources.providerIds,
        createdAt: current.createdAt
      });
      upgraded += 1;
    }
  }
  return { seeded, upgraded };
}
