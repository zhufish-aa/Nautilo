/**
 * Frozen v2 built-in skill bodies. Kept verbatim so the seeder can detect an
 * *untouched* v2 install by exact body match and upgrade it to v3, while any
 * user edit (even a single appended line) fails the match and is preserved.
 * Do not edit these constants — they are a snapshot of what v2 shipped.
 */

const V2_COMMON_RULES = `
## Environment rules
- Work inside the session workspace directory. Never touch files outside it.
- Third-party Python packages go into an isolated environment (\`python -m venv .venv\` in the workspace), never the system Python. The bundled scripts print the exact setup command when a dependency is missing.
- Verify before you report: run \`inspect\` (and \`render\` when LibreOffice is available) and fix every issue it finds. Never claim quality without evidence.
- End your reply with the exact path of every deliverable you created or updated.
`.trim();

const V2_DOCUMENTS = `
# Office Documents (.docx) — script-first workflow

Produce professional Word documents. The bundled scripts next to this SKILL.md are the primary toolchain — use them instead of improvising.

## Toolchain
- \`python scripts/office_scaffold.py docx out.docx --title "..." [--subtitle "..."]\` — styled skeleton: Normal + Heading 1-3 fonts (Latin & CJK), margins, centered title, footer page numbers. Always start from this, never from a blank Document().
- \`python scripts/render_verify.py inspect out.docx\` — structural audit as JSON: heading outline order, table dimensions, image count, margins, placeholder text. Exit code 1 = findings to fix.
- \`python scripts/render_verify.py render out.docx [--out rendered]\` — LibreOffice converts to PDF; page PNGs when pdftoppm is available. Use it to prove the file opens in a real Office app.

## Writing the content
- Fill the scaffold with python-docx: heading levels in order (they drive the navigation pane), real styled tables for tabular data, consistent terminology, no filler text.
- Reusable helpers: add the scripts directory to sys.path and \`from office_scaffold import style_docx, add_docx_footer_pagenum\`.

## Done means
1. \`inspect\` passes with zero issues.
2. \`render\` succeeded (or LibreOffice is confirmed absent — say so).
3. The reply ends with the absolute path of the .docx.
`.trim();

const V2_SPREADSHEETS = `
# Office Spreadsheets (.xlsx) — script-first workflow

Produce professional Excel workbooks with openpyxl. The bundled scripts next to this SKILL.md are the primary toolchain.

## Toolchain
- \`python scripts/xlsx_build.py new out.xlsx --sheets Data,Summary\` — workbook with the sheet structure.
- Write data with openpyxl: header row first, raw data untouched on its own sheet, analysis on separate sheets referencing it. Use real Excel formulas (SUM, ratios) for computed columns so the workbook stays live; number formats for currency/percent/dates — never raw floats in presentation sheets.
- \`python scripts/xlsx_build.py style out.xlsx\` — header fill + bold white text, frozen top row, autofilter, content-sized columns.
- \`python scripts/xlsx_build.py verify out.xlsx\` — JSON report: sheet dims, freeze/filter state, every formula with its cached value. Exit code 1 = findings.
- \`python scripts/render_verify.py render out.xlsx\` — optional LibreOffice smoke test proving the file opens.

## Data quality
- Cross-check a sample of formula results in Python against the inputs before shipping.
- Charts (openpyxl.chart) for trends and comparisons; place them beside the data.

## Done means
1. \`verify\` passes with zero issues (formulas carry cached values or you explain why).
2. The reply ends with the absolute path of the .xlsx.
`.trim();

const V2_PRESENTATIONS = `
# Office Presentations (.pptx) — script-first workflow

Produce professional 16:9 slide decks with python-pptx. The bundled scripts next to this SKILL.md are the primary toolchain.

## Toolchain
- \`python scripts/office_scaffold.py pptx out.pptx --title "..." [--subtitle "..."] [--demo]\` — 16:9 deck with a styled title slide.
- Extend it by importing the helpers: add the scripts directory to sys.path, then \`from office_scaffold import new_prs, add_title_slide, add_section_slide, add_content_slide\`. \`add_content_slide(prs, title, [(0, "point"), (1, "detail")])\` enforces the type hierarchy (24pt title / 18-14pt body).
- \`python scripts/render_verify.py inspect out.pptx\` — JSON audit per slide: char budgets, sub-10pt fonts, text-box overflow estimates. Exit code 1 = findings.
- \`python scripts/render_verify.py render out.pptx [--out rendered]\` — LibreOffice → PDF (+ page PNGs with pdftoppm). Review the images yourself when available.

## Design rules
- One message per slide; ~8-15 slides; max ~6 bullet lines per slide; title 24-34pt, body ≥ 14pt.
- Narrative order: title → agenda/section dividers → content → conclusion. Speaker notes for slides carrying numbers or claims.

## Done means
1. \`inspect\` passes with zero issues.
2. \`render\` succeeded (or LibreOffice is confirmed absent — say so).
3. The reply ends with the absolute path of the .pptx.
`.trim();

const V2_RESEARCH = `
# Research Reports — evidence-first workflow

Produce structured, source-backed research reports (Markdown source, optional .docx export).

## Workflow
1. Decompose the question into 3-7 sub-questions; gather evidence for each before writing.
2. Structure: executive summary first (half a page, answer-first), findings per sub-question, comparison/recommendation, sources.
3. Every non-obvious claim carries a source (URL + what it supports). Mark anything unverifiable as "unverified" — never state it as fact, never invent a URL.
4. Tables for comparisons; tight prose — a report is read for its conclusions.

## Export & verification
- Deliver the .md file. For .docx: \`python scripts/office_scaffold.py docx report.docx --title "..."\` then convert content with pandoc or python-docx.
- \`python scripts/render_verify.py inspect report.docx\` before shipping any .docx.
- Confirm every cited URL actually appeared in your gathered evidence, and that the summary answers the original question in isolation.
`.trim();

/** Exact instructions bodies shipped as builtin-v2, keyed by capability id. */
export const V2_BODIES: Record<string, string> = {
  "builtin-office-documents": `${V2_DOCUMENTS}\n\n${V2_COMMON_RULES}`,
  "builtin-office-spreadsheets": `${V2_SPREADSHEETS}\n\n${V2_COMMON_RULES}`,
  "builtin-office-presentations": `${V2_PRESENTATIONS}\n\n${V2_COMMON_RULES}`,
  "builtin-office-research": `${V2_RESEARCH}\n\n${V2_COMMON_RULES}`
};

const V3_DOCUMENTS = `
# Office Documents (.docx) — script-first workflow

Produce professional Word documents. The bundled scripts next to this SKILL.md are the primary toolchain — use them instead of improvising.

## Toolchain
- \`python scripts/office_scaffold.py docx out.docx --title "..." [--subtitle "..."] [--theme business|academic|elegant] [--cover] [--toc]\` — styled skeleton: Normal + Heading 1-3 fonts (Latin & CJK), margins, running header, footer page numbers; optional cover page and a real TOC field. Always start from this, never from a blank Document().
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

const V3_SPREADSHEETS = `
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

const V3_PRESENTATIONS = `
# Office Presentations (.pptx) — script-first workflow

Produce professional 16:9 slide decks with python-pptx. The bundled scripts next to this SKILL.md are the primary toolchain.

## Toolchain
- \`python scripts/office_scaffold.py pptx out.pptx --title "..." [--subtitle "..."] [--theme business|academic|elegant] [--demo]\` — 16:9 deck with a styled title slide; \`--demo\` adds one sample of every layout. \`elegant\` is a dark theme with light text.
- Extend it by importing the layout library (add the scripts directory to sys.path, then \`from office_scaffold import ...\`):
  - \`add_title_slide(prs, title, subtitle)\` / \`add_section_slide(prs, title)\` / \`add_closing_slide(prs, ...)\`
  - \`add_agenda_slide(prs, items)\` — numbered agenda.
  - \`add_content_slide(prs, title, [(0, "point"), (1, "detail")])\` — bullets, levels 0-2, enforced type hierarchy (24pt title / 18-14pt body).
  - \`add_two_column_slide(prs, title, left, right)\` — two bullet columns.
  - \`add_table_slide(prs, title, rows)\` — styled table, accent header row.
  - \`add_image_slide(prs, title, image_path, caption)\` — full-width image + caption.
  - \`add_chart_slide(prs, title, categories, [("Series", (v1, v2, ...))], "bar|line|pie")\` — native editable chart.
  - \`add_quote_slide(prs, quote, attribution)\` — big quotation.
  - \`set_speaker_notes(slide, text)\` — required on slides carrying numbers or charts.
- \`python scripts/render_verify.py inspect out.pptx\` — JSON audit per slide: char budgets, overflow estimates, sub-10pt fonts, empty slides, chart slides missing notes, font-family sprawl. Exit code 1 = findings.
- \`python scripts/render_verify.py render out.pptx [--out rendered]\` — LibreOffice → PDF (+ page PNGs with pdftoppm). Review the images yourself when available.

## Design rules
- One message per slide; ~8-15 slides; max ~6 bullet lines per slide; title 24-34pt, body ≥ 14pt.
- Narrative order: title → agenda → section dividers → content (mix table/chart/image layouts, not wall-of-bullets) → conclusion.
- Pick the layout that fits the content: comparisons → two-column or table, trends → chart, evidence → image, transitions → quote.

## Done means
1. \`inspect\` passes with zero issues.
2. \`render\` succeeded (or LibreOffice is confirmed absent — say so).
3. The reply ends with the absolute path of the .pptx.
`.trim();

const V3_RESEARCH = `
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

/** Exact instructions bodies shipped as builtin-v3, keyed by capability id. */
export const V3_BODIES: Record<string, string> = {
  "builtin-office-documents": `${V3_DOCUMENTS}\n\n${V2_COMMON_RULES}`,
  "builtin-office-spreadsheets": `${V3_SPREADSHEETS}\n\n${V2_COMMON_RULES}`,
  "builtin-office-presentations": `${V3_PRESENTATIONS}\n\n${V2_COMMON_RULES}`,
  "builtin-office-research": `${V3_RESEARCH}\n\n${V2_COMMON_RULES}`
};

const V4_PRESENTATIONS = `
# Office Presentations (.pptx) — script-first workflow

Produce professional 16:9 slide decks with python-pptx. The bundled scripts next to this SKILL.md are the primary toolchain. Decks should look DESIGNED, not default: use the theme palette, kickers, cards and glow backgrounds the helpers give you — never a wall of plain text boxes on white.

## Toolchain
- \`python scripts/office_scaffold.py pptx out.pptx --title "..." [--subtitle "..."] [--theme aurora] [--kicker "ACME INC"] [--footer "ACME · Confidential"] [--demo]\` — 16:9 deck with a designed title slide; \`--demo\` adds one sample of every layout. Themes: \`aurora\` (dark navy + cyan glow, keynote style — the default recommendation), \`business\`, \`academic\`, \`elegant\` (dark/gold). The aurora glow background renders with pillow; without it a native gradient is used (say so and suggest \`pip install pillow\`).
- Extend it by importing the layout library (add the scripts directory to sys.path, then \`from office_scaffold import ...\`):
  - \`add_title_slide(prs, title, subtitle, kicker=..., footer=...)\` / \`add_section_slide(prs, title, kicker="PART 01")\` / \`add_closing_slide(prs, ..., footer=...)\`
  - \`add_agenda_slide(prs, items)\` — big accent numerals with hairline dividers.
  - \`add_cards_slide(prs, title, [("01", "Heading", "description"), ...], kicker=...)\` — rounded cards; the workhorse layout for features/pillars/options. 2-4 cards per slide.
  - \`add_stats_slide(prs, title, [("98%", "uptime"), ...])\` — big-number callouts.
  - \`add_content_slide(prs, title, [(0, "point"), (1, "detail")])\` — bullets, levels 0-2, enforced type hierarchy (24pt title / 18-14pt body).
  - \`add_two_column_slide(prs, title, left, right)\` — two bullet columns.
  - \`add_table_slide(prs, title, rows)\` — styled table, accent header row.
  - \`add_image_slide(prs, title, image_path, caption)\` — full-width image + caption.
  - \`add_chart_slide(prs, title, categories, [("Series", (v1, v2, ...))], "bar|line|pie")\` — native editable chart.
  - \`add_quote_slide(prs, quote, attribution)\` — big quotation.
  - \`add_kicker(slide, text)\` / \`add_footer(slide, text, number)\` — slide furniture for a consistent frame.
  - \`set_speaker_notes(slide, text)\` — required on slides carrying numbers or charts.
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

/** Exact instructions bodies shipped as builtin-v4, keyed by capability id.
 * documents/spreadsheets/research were unchanged from v3; only presentations
 * shipped a new body in v4. */
export const V4_BODIES: Record<string, string> = {
  "builtin-office-documents": `${V3_DOCUMENTS}\n\n${V2_COMMON_RULES}`,
  "builtin-office-spreadsheets": `${V3_SPREADSHEETS}\n\n${V2_COMMON_RULES}`,
  "builtin-office-presentations": `${V4_PRESENTATIONS}\n\n${V2_COMMON_RULES}`,
  "builtin-office-research": `${V3_RESEARCH}\n\n${V2_COMMON_RULES}`
};

/** Every exact body ever shipped, per capability id — an untouched install matches one of them. */
export const LEGACY_BODIES: Record<string, string[]> = Object.fromEntries(
  Object.keys(V2_BODIES).map((id) => [id, [V2_BODIES[id], V3_BODIES[id], V4_BODIES[id]]])
);
