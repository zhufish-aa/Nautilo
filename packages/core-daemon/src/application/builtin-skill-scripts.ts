/**
 * Python toolchain bundled with the built-in office skill pack. Sources are
 * embedded so the packaged app needs no asset pipeline; the seeder writes them
 * to <dataDir>/builtin-skills/<slug>/scripts/ and SkillFileSync mirrors them
 * next to each provider's SKILL.md.
 *
 * Script authoring rules: stdlib imports only at module top, third-party
 * libraries imported lazily with an actionable error, JSON on stdout, never a
 * stack trace for expected failures. Keep free of backticks and "${" (this
 * file is a TS template).
 */

export const RENDER_VERIFY_PY = `#!/usr/bin/env python3
"""Render and structurally verify Office deliverables (docx / xlsx / pptx).

Usage:
  python render_verify.py inspect <file>            Structural audit, JSON out.
  python render_verify.py render <file> [--out D]   LibreOffice -> PDF, then
                                                    PNG pages via pdftoppm.

Exit code is 0 on success, 1 on any finding or failure (read "ok" / "issues").
"""
import argparse
import importlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

PLACEHOLDER = re.compile(r"(?i)(lorem ipsum|TODO\\b|FIXME\\b|placeholder|\\bTBD\\b)")


def fail(message, code=1):
    print(json.dumps({"ok": False, "error": message}, indent=2))
    sys.exit(code)


def require(module, pip_name):
    try:
        return importlib.import_module(module)
    except ImportError:
        fail(
            "Missing dependency '" + pip_name + "'. Create an isolated environment first: "
            "python -m venv .venv, then .venv/Scripts/pip install " + pip_name + " (Windows) "
            "or .venv/bin/pip install " + pip_name + " (macOS/Linux), and re-run with that interpreter."
        )


def inspect_docx(path):
    docx = require("docx", "python-docx")
    doc = docx.Document(str(path))
    issues = []
    headings = []
    placeholder_hits = 0
    nonempty = 0
    for para in doc.paragraphs:
        if para.text.strip():
            nonempty += 1
        style = para.style.name if para.style is not None else ""
        if style.startswith("Heading"):
            try:
                level = int(style.split()[-1])
            except ValueError:
                level = 0
            if headings and level - headings[-1]["level"] > 1:
                issues.append("Heading level jumps from H" + str(headings[-1]["level"]) + " to H" + str(level) + ': "' + para.text[:60] + '"')
            headings.append({"level": level, "text": para.text[:80]})
        if PLACEHOLDER.search(para.text):
            placeholder_hits += 1
    if nonempty == 0 and not doc.tables and not doc.inline_shapes:
        issues.append("Document is empty — no paragraphs, tables or images")
    if placeholder_hits:
        issues.append(str(placeholder_hits) + " paragraph(s) contain placeholder text (TODO/lorem/TBD)")
    seen = {}
    for heading in headings:
        key = heading["text"].strip()
        if key:
            seen[key] = seen.get(key, 0) + 1
    duplicates = [text for text, count in seen.items() if count > 1]
    if duplicates:
        issues.append("Duplicate heading text: " + "; ".join(d[:40] for d in duplicates[:5]))
    tables = []
    for table in doc.tables:
        header_empty = bool(table.rows) and all(not (cell.text or "").strip() for cell in table.rows[0].cells)
        if header_empty:
            issues.append("A " + str(len(table.rows)) + "x" + str(len(table.columns)) + " table has an empty header row")
        tables.append({"rows": len(table.rows), "cols": len(table.columns), "headerEmpty": header_empty})
    section = doc.sections[0] if doc.sections else None
    return {
        "type": "docx",
        "paragraphs": len(doc.paragraphs),
        "headings": len(headings),
        "headingOutline": headings[:40],
        "tables": tables,
        "images": len(doc.inline_shapes),
        "hasToc": "TOC" in doc.element.xml,
        "marginsCm": None if section is None else {
            "top": round(section.top_margin.cm, 2), "bottom": round(section.bottom_margin.cm, 2),
            "left": round(section.left_margin.cm, 2), "right": round(section.right_margin.cm, 2)
        },
        "issues": issues
    }


def inspect_pptx(path):
    pptx = require("pptx", "python-pptx")
    from pptx.util import Emu
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    prs = pptx.Presentation(str(path))
    issues = []
    slides = []
    families = set()
    for index, slide in enumerate(prs.slides, start=1):
        chars = 0
        font_sizes = []
        frames = 0
        pictures = 0
        has_chart = False
        for shape in slide.shapes:
            if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                pictures += 1
            if getattr(shape, "has_chart", False):
                has_chart = True
            if not shape.has_text_frame:
                continue
            frames += 1
            frame_chars = 0
            for para in shape.text_frame.paragraphs:
                for run in para.runs:
                    frame_chars += len(run.text)
                    if run.font.size is not None:
                        font_sizes.append(round(run.font.size.pt, 1))
                    if run.font.name:
                        families.add(run.font.name)
            if frame_chars > 350:
                issues.append("Slide " + str(index) + ": one text frame holds " + str(frame_chars) + " chars (split it)")
            # Rough overflow estimate: ~55 chars per square inch at 18pt.
            if shape.width and shape.height:
                area = Emu(shape.width).inches * Emu(shape.height).inches
                if area > 0 and frame_chars > area * 66:
                    issues.append("Slide " + str(index) + ": text likely overflows its box (" + str(frame_chars) + " chars in " + str(round(area, 1)) + " sq in)")
            chars += frame_chars
        if chars > 700:
            issues.append("Slide " + str(index) + ": " + str(chars) + " chars total — over the ~700 readability budget")
        if frames == 0 and pictures == 0 and not has_chart:
            issues.append("Slide " + str(index) + ": empty slide (no text, image or chart)")
        small = [size for size in font_sizes if size < 10]
        if small:
            issues.append("Slide " + str(index) + ": font below 10pt detected (" + str(min(small)) + "pt)")
        notes = slide.notes_slide.notes_text_frame.text.strip() if slide.has_notes_slide else ""
        if has_chart and not notes:
            issues.append("Slide " + str(index) + ": chart slide without speaker notes")
        slides.append({"slide": index, "shapes": len(slide.shapes), "textFrames": frames, "chars": chars,
                       "pictures": pictures, "chart": has_chart, "notes": bool(notes),
                       "fontMin": min(font_sizes) if font_sizes else None, "fontMax": max(font_sizes) if font_sizes else None})
    if len(families) > 3:
        issues.append(str(len(families)) + " distinct font families in use (" + ", ".join(sorted(families)[:6]) + ") — unify them")
    return {
        "type": "pptx",
        "slides": len(slides),
        "sizeInches": {"w": round(Emu(prs.slide_width).inches, 2), "h": round(Emu(prs.slide_height).inches, 2)},
        "fontFamilies": sorted(families),
        "perSlide": slides,
        "issues": issues
    }


def inspect_xlsx(path):
    openpyxl = require("openpyxl", "openpyxl")
    wb = openpyxl.load_workbook(str(path), data_only=False)
    wb_values = openpyxl.load_workbook(str(path), data_only=True)
    issues = []
    sheets = []
    for name in wb.sheetnames:
        ws = wb[name]
        ws_values = wb_values[name]
        formulas = []
        formatted = 0
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and cell.value.startswith("="):
                    formulas.append({"cell": cell.coordinate, "formula": cell.value[:80],
                                     "cached": ws_values[cell.coordinate].value})
                if cell.value is not None and cell.number_format != "General":
                    formatted += 1
        uncached = [f["cell"] for f in formulas if f["cached"] is None]
        if uncached:
            issues.append("Sheet '" + name + "': " + str(len(uncached)) + " formula(s) never calculated (open in Excel/LibreOffice once or verify inputs)")
        headers = [ws.cell(row=1, column=col).value for col in range(1, min(ws.max_column, 12) + 1)]
        if ws.max_row > 1 and all(value is None for value in headers):
            issues.append("Sheet '" + name + "': first row is empty — missing header row?")
        blank_rows = []
        if ws.max_row > 1:
            for row in ws.iter_rows(min_row=2):
                if all(cell.value is None for cell in row):
                    blank_rows.append(row[0].row)
        if blank_rows:
            issues.append("Sheet '" + name + "': " + str(len(blank_rows)) + " fully blank row(s) inside the used range (rows " + ",".join(str(r) for r in blank_rows[:8]) + ")")
        sheets.append({
            "name": name, "rows": ws.max_row, "cols": ws.max_column,
            "freeze": ws.freeze_panes, "autoFilter": ws.auto_filter.ref,
            "headers": headers, "formulas": len(formulas), "formulaSample": formulas[:10],
            "mergedCells": len(ws.merged_cells.ranges), "blankRows": blank_rows[:20],
            "formattedCells": formatted, "charts": len(getattr(ws, "_charts", []))
        })
    return {"type": "xlsx", "sheets": sheets, "issues": issues}


def find_soffice():
    candidate = shutil.which("soffice") or shutil.which("libreoffice")
    if candidate:
        return candidate
    for path in [
        r"C:/Program Files/LibreOffice/program/soffice.exe",
        r"C:/Program Files (x86)/LibreOffice/program/soffice.exe",
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        "/usr/bin/soffice", "/usr/local/bin/soffice", "/snap/bin/libreoffice"
    ]:
        if Path(path).exists():
            return path
    return None


def pdf_page_count(pdf_path):
    data = Path(pdf_path).read_bytes()
    return max(len(re.findall(rb"/Type\\s*/Page[^s]", data)), 1)


def render(path, out_dir, max_pages):
    soffice = find_soffice()
    if not soffice:
        fail("LibreOffice (soffice) not found. Install it or skip render and rely on 'inspect'.", code=2)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(
            [soffice, "--headless", "--convert-to", "pdf", "--outdir", str(out), str(path)],
            capture_output=True, text=True, timeout=180
        )
    except subprocess.TimeoutExpired:
        fail("LibreOffice conversion timed out after 180s")
    pdf = out / (Path(path).stem + ".pdf")
    if proc.returncode != 0 or not pdf.exists():
        fail("LibreOffice conversion failed: " + (proc.stderr or proc.stdout).strip()[:400])
    result = {"ok": True, "pdf": str(pdf), "pages": pdf_page_count(pdf), "pngs": []}
    pdftoppm = shutil.which("pdftoppm")
    if pdftoppm:
        prefix = str(out / (Path(path).stem + "-page"))
        try:
            subprocess.run([pdftoppm, "-png", "-r", "110", "-l", str(max_pages), str(pdf), prefix],
                           capture_output=True, timeout=120)
            result["pngs"] = sorted(str(p) for p in out.glob(Path(path).stem + "-page-*.png"))
        except subprocess.TimeoutExpired:
            result["pngError"] = "pdftoppm timed out"
    else:
        result["pngNote"] = "pdftoppm not found; PDF rendered but no page images"
    return result


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Verify and render Office deliverables")
    sub = parser.add_subparsers(dest="command", required=True)
    p_inspect = sub.add_parser("inspect")
    p_inspect.add_argument("file")
    p_render = sub.add_parser("render")
    p_render.add_argument("file")
    p_render.add_argument("--out", default="rendered")
    p_render.add_argument("--pages", type=int, default=12)
    args = parser.parse_args()

    path = Path(args.file)
    if not path.is_file():
        fail("File not found: " + str(path))
    ext = path.suffix.lower()

    if args.command == "inspect":
        if ext == ".docx":
            result = inspect_docx(path)
        elif ext == ".pptx":
            result = inspect_pptx(path)
        elif ext in (".xlsx", ".xlsm"):
            result = inspect_xlsx(path)
        else:
            fail("inspect supports .docx / .pptx / .xlsx, got: " + ext)
        result["ok"] = not result["issues"]
        print(json.dumps(result, indent=2, ensure_ascii=False))
        sys.exit(0 if result["ok"] else 1)

    if args.command == "render":
        if ext not in (".docx", ".pptx", ".xlsx", ".xlsm", ".odt", ".ods", ".odp"):
            fail("render supports office documents, got: " + ext)
        print(json.dumps(render(path, args.out, args.pages), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
`;

export const OFFICE_SCAFFOLD_PY = `#!/usr/bin/env python3
"""Generate styled Office skeletons so deliverables start from a professional
base instead of a blank document.

Usage:
  python office_scaffold.py docx <out.docx> --title "..." [--subtitle "..."] [--accent 305496] [--latin-font Calibri] [--cjk-font "Microsoft YaHei"] [--cover] [--toc]
  python office_scaffold.py pptx <out.pptx> --title "..." [--subtitle "..."] [style tokens] [--kicker "..."] [--footer "..."] [--demo]

There are NO built-in themes. Every visual is a style token you control —
the CSS of the deck:
  --accent 35C4DC     brand color (kickers, dashes, numerals, table headers)
  --bg 0B1D33         background color (default FFFFFF = plain white)
  --bg-to 06101C      second stop -> gradient background instead of solid
  --glow              soft accent-halo background PNG (needs pillow)
  --ink F2F7FA        primary text color   --muted 9FB3C8   secondary text
  --surface 13304A    card/table fill      --latin-font / --cjk-font
Importable helpers (add this script's directory to sys.path):
  from office_scaffold import (
      set_style, make_glow_background, style_docx, add_docx_footer_pagenum,
      add_docx_header, add_toc, add_table, add_image, add_callout, add_code,
      new_prs, add_title_slide, add_agenda_slide, add_section_slide,
      add_content_slide, add_two_column_slide, add_cards_slide,
      add_stats_slide, add_table_slide, add_image_slide, add_chart_slide,
      add_quote_slide, add_closing_slide, add_kicker, add_footer,
      set_speaker_notes)
  # API styling: set_style(accent="35C4DC", bg="0B1D33", bgTo="06101C",
  #                        glow=True, ink="F2F7FA", muted="9FB3C8", surface="13304A")
"""
import argparse
import importlib
import json
import sys
from pathlib import Path


def fail(message):
    print(json.dumps({"ok": False, "error": message}, indent=2))
    sys.exit(1)


def require(module, pip_name):
    try:
        return importlib.import_module(module)
    except ImportError:
        fail(
            "Missing dependency '" + pip_name + "'. Create an isolated environment first: "
            "python -m venv .venv, then .venv/Scripts/pip install " + pip_name + " (Windows) "
            "or .venv/bin/pip install " + pip_name + " (macOS/Linux), and re-run with that interpreter."
        )


def hex_to_rgb(hex_color):
    value = hex_color.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def lighten(hex_color, factor=0.85):
    """Mix a hex color with white; factor 0.85 = very light tint."""
    return "".join("%02X" % round(channel + (255 - channel) * factor) for channel in hex_to_rgb(hex_color))


# ------------------------------------------------------------- styles ----
# No built-in themes: a neutral light default plus caller-supplied tokens.
# Think of these as the CSS custom properties of the document.

DEFAULT_STYLE = {
    "accent": "305496",
    "bg": "FFFFFF",
    "bgTo": None,
    "glow": False,
    "surface": "F2F5FA",
    "ink": "1F1F1F",
    "muted": "595959",
    "latin": "Calibri",
    "cjk": "Microsoft YaHei"
}
CURRENT = dict(DEFAULT_STYLE)
_COLOR_TOKENS = ("accent", "bg", "bgTo", "surface", "ink", "muted")


def set_style(**tokens):
    """Override style tokens, e.g. set_style(accent='35C4DC', bg='0B1D33',
    bgTo='06101C', glow=True, ink='F2F7FA', muted='9FB3C8', surface='13304A').
    Unknown tokens and malformed colors are rejected with a helpful error."""
    unknown = [key for key in tokens if key not in DEFAULT_STYLE]
    if unknown:
        fail("Unknown style token(s): " + ", ".join(unknown) +
             ". Choose from: " + ", ".join(sorted(DEFAULT_STYLE)))
    for key, value in tokens.items():
        if value is None:
            continue
        if key in _COLOR_TOKENS:
            value = str(value).lstrip("#")
            if len(value) != 6 or any(c not in "0123456789abcdefABCDEF" for c in value):
                fail("Style token '" + key + "' must be a 6-digit hex color, got: " + str(value))
        CURRENT[key] = value
    return CURRENT


def _is_dark():
    """Luminance check on the background — display type and chart fonts adapt."""
    r, g, b = hex_to_rgb(CURRENT.get("bg") or "FFFFFF")
    return (0.299 * r + 0.587 * g + 0.114 * b) < 140


def _ink():
    return hex_to_rgb(CURRENT["ink"])


def _muted():
    return hex_to_rgb(CURRENT["muted"])


# ---------------------------------------------------------------- docx ----

def _shade(element_pr, hex_fill):
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), hex_fill)
    element_pr.append(shd)


def style_docx(doc, accent=None, cjk_font=None, base_font=None):
    """Apply the house style: base font (Latin+CJK), heading hierarchy, margins."""
    docx = require("docx", "python-docx")
    from docx.shared import Pt, Cm, RGBColor
    from docx.oxml.ns import qn
    accent = (accent or CURRENT["accent"]).lstrip("#")
    cjk_font = cjk_font or CURRENT["cjk"]
    base_font = base_font or CURRENT["latin"]
    rgb = RGBColor(*hex_to_rgb(accent))

    normal = doc.styles["Normal"]
    normal.font.name = base_font
    normal.font.size = Pt(11)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), cjk_font)

    for level, size in ((1, 16), (2, 13), (3, 11.5)):
        style = doc.styles["Heading " + str(level)]
        style.font.name = base_font
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = rgb if level == 1 else RGBColor(0x1F, 0x1F, 0x1F)
        if style.element.rPr is not None and style.element.rPr.rFonts is not None:
            style.element.rPr.rFonts.set(qn("w:eastAsia"), cjk_font)

    for section in doc.sections:
        section.top_margin = Cm(2.54)
        section.bottom_margin = Cm(2.54)
        section.left_margin = Cm(3.0)
        section.right_margin = Cm(3.0)
    return doc


def add_docx_footer_pagenum(doc):
    """Centered 'page X' field in the footer of every section."""
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    for section in doc.sections:
        paragraph = section.footer.paragraphs[0] if section.footer.paragraphs else section.footer.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        field = OxmlElement("w:fldSimple")
        field.set(qn("w:instr"), "PAGE")
        paragraph._p.append(field)
    return doc


def add_docx_header(doc, text):
    """Running header: small gray text with an accent rule underneath."""
    from docx.shared import Pt, RGBColor
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    for section in doc.sections:
        paragraph = section.header.paragraphs[0] if section.header.paragraphs else section.header.add_paragraph()
        run = paragraph.add_run(text)
        run.font.size = Pt(9)
        run.font.color.rgb = RGBColor(*_muted())
        p_pr = paragraph._p.get_or_add_pPr()
        border = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        bottom.set(qn("w:val"), "single")
        bottom.set(qn("w:sz"), "6")
        bottom.set(qn("w:color"), CURRENT["accent"])
        border.append(bottom)
        p_pr.append(border)
    return doc


def add_toc(doc):
    """Insert a real TOC field (levels 1-3). Word/LibreOffice builds the entries
    on 'Update Field'; until then a hint line shows."""
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    paragraph = doc.add_paragraph()
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = r'TOC \\o "1-3" \\h \\z \\u'
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    hint = OxmlElement("w:t")
    hint.text = "Table of contents — right-click and choose 'Update Field' to build it."
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    for node in (begin, instr, separate, hint, end):
        run._r.append(node)
    return paragraph


def add_table(doc, rows, header=True):
    """Styled table: accent header row (white bold), banded rows, thin grid."""
    from docx.shared import Pt, RGBColor
    table = doc.add_table(rows=len(rows), cols=len(rows[0]))
    table.style = "Table Grid"
    band = lighten(CURRENT["accent"], 0.88)
    for r, row in enumerate(rows):
        for c, value in enumerate(row):
            cell = table.cell(r, c)
            cell.text = str(value)
            for paragraph in cell.paragraphs:
                for run in paragraph.runs:
                    run.font.size = Pt(10)
                    if header and r == 0:
                        run.font.bold = True
                        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
            if header and r == 0:
                _shade(cell._tc.get_or_add_tcPr(), CURRENT["accent"])
            elif r % 2 == 1:
                _shade(cell._tc.get_or_add_tcPr(), band)
    return table


def add_image(doc, path, width_in=6.0, caption=None):
    """Centered image plus an auto-numbered 'Figure N:' caption."""
    from docx.shared import Inches, Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    doc.add_picture(str(path), width=Inches(width_in))
    doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
    count = getattr(doc, "_figure_count", 0) + 1
    doc._figure_count = count
    if caption:
        cap = doc.add_paragraph()
        cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = cap.add_run("Figure " + str(count) + ": " + caption)
        run.font.size = Pt(9)
        run.font.color.rgb = RGBColor(0x59, 0x59, 0x59)
    return doc


def add_callout(doc, text, kind="note"):
    """Shaded callout block. kind: note (accent tint) | warning | tip."""
    from docx.shared import Pt
    fills = {"note": lighten(CURRENT["accent"], 0.85), "warning": "FBEAEA", "tip": "EAF4EA"}
    paragraph = doc.add_paragraph()
    _shade(paragraph._p.get_or_add_pPr(), fills.get(kind, fills["note"]))
    run = paragraph.add_run(text)
    run.font.size = Pt(10.5)
    return paragraph


def add_code(doc, text):
    """Monospace code block on a light gray shade."""
    from docx.shared import Pt
    paragraph = doc.add_paragraph()
    _shade(paragraph._p.get_or_add_pPr(), "F2F2F2")
    run = paragraph.add_run(text)
    run.font.name = "Consolas"
    run.font.size = Pt(9.5)
    return paragraph


def add_cover(doc, title, subtitle, accent):
    """Cover page: accent rule, large title, subtitle, date; ends with a page break."""
    import datetime
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    for _ in range(6):
        doc.add_paragraph()
    rule = doc.add_paragraph()
    p_pr = rule._p.get_or_add_pPr()
    border = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "24")
    bottom.set(qn("w:color"), accent)
    border.append(bottom)
    p_pr.append(border)
    title_para = doc.add_paragraph()
    title_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title_para.add_run(title)
    run.font.size = Pt(28)
    run.font.bold = True
    run.font.color.rgb = RGBColor(*hex_to_rgb(accent))
    if subtitle:
        sub = doc.add_paragraph()
        sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
        sub_run = sub.add_run(subtitle)
        sub_run.font.size = Pt(14)
        sub_run.font.color.rgb = RGBColor(*_muted())
    date_para = doc.add_paragraph()
    date_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    date_run = date_para.add_run(datetime.date.today().isoformat())
    date_run.font.size = Pt(11)
    date_run.font.color.rgb = RGBColor(*_muted())
    doc.add_page_break()
    return doc


def scaffold_docx(out, title, subtitle, accent, cover, toc):
    docx = require("docx", "python-docx")
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    doc = docx.Document()
    style_docx(doc, accent=accent)
    add_docx_header(doc, title)
    add_docx_footer_pagenum(doc)

    if cover:
        add_cover(doc, title, subtitle, accent)
    else:
        title_para = doc.add_paragraph()
        title_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = title_para.add_run(title)
        run.font.size = Pt(22)
        run.font.bold = True
        run.font.color.rgb = RGBColor(*hex_to_rgb(accent))
        if subtitle:
            sub = doc.add_paragraph()
            sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
            sub_run = sub.add_run(subtitle)
            sub_run.font.size = Pt(12)
            sub_run.font.color.rgb = RGBColor(0x59, 0x59, 0x59)
        doc.add_paragraph()
    if toc:
        doc.add_heading("Contents", level=1)
        add_toc(doc)
        doc.add_page_break()
    doc.save(str(out))
    features = ["Normal/Heading 1-3 fonts", "margins 2.54cm", "header + footer page numbers"]
    if cover:
        features.append("cover page")
    if toc:
        features.append("TOC field (update in Word)")
    return {"ok": True, "path": str(out),
            "note": "Styled skeleton: " + ", ".join(features) + ". Fill with python-docx; helpers add_table/add_image/add_callout/add_code importable from office_scaffold."}


# ---------------------------------------------------------------- pptx ----

SLIDE_W = 13.333
SLIDE_H = 7.5


def _pptx_textbox(slide, left, top, width, height):
    pptx = require("pptx", "python-pptx")
    from pptx.util import Inches
    return slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))


def _set_runs(paragraph, text, size, bold=False, color=None, italic=False):
    """Add one styled run; applies theme fonts (Latin + East Asian) and ink color."""
    from pptx.util import Pt
    from pptx.dml.color import RGBColor
    from pptx.oxml.ns import qn
    run = paragraph.add_run()
    run.text = text
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    run.font.color.rgb = RGBColor(*(color if color is not None else _ink()))
    run.font.name = CURRENT["latin"]
    rPr = run.font._rPr
    ea = rPr.find(qn("a:ea"))
    if ea is None:
        ea = rPr.makeelement(qn("a:ea"), {})
        rPr.append(ea)
    ea.set("typeface", CURRENT["cjk"])
    return run


def make_glow_background(path, theme=None):
    """Render a soft aurora background PNG (dark vertical gradient + blurred
    accent glows). Returns the file path, or None when pillow is missing —
    callers then fall back to the native gradient in _apply_bg."""
    try:
        from PIL import Image, ImageDraw, ImageFilter
    except ImportError:
        return None
    theme = theme or CURRENT
    width, height = 1920, 1080
    top = hex_to_rgb(theme["bg"])
    bottom = tuple(max(0, int(channel * 0.5)) for channel in top)
    base = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(base)
    for y in range(height):
        ratio = y / height
        draw.line([(0, y), (width, y)],
                  fill=tuple(round(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3)))
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    accent = hex_to_rgb(theme["accent"])
    halo = tuple(min(255, int(channel * 1.6)) for channel in top)
    gdraw.ellipse([width * 0.55, -height * 0.5, width * 1.4, height * 0.6], fill=accent + (110,))
    gdraw.ellipse([-width * 0.3, height * 0.4, width * 0.5, height * 1.5], fill=halo + (90,))
    glow = glow.filter(ImageFilter.GaussianBlur(220))
    base = Image.alpha_composite(base.convert("RGBA"), glow).convert("RGB")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    base.save(str(path))
    return str(path)


def _apply_bg(slide):
    """Background from style tokens: glow PNG > bgTo gradient > solid. White stays blank."""
    from pptx.dml.color import RGBColor
    from pptx.util import Inches
    bg = CURRENT.get("bg") or "FFFFFF"
    bg_to = CURRENT.get("bgTo")
    png = CURRENT.get("glowPng")
    if png:
        slide.shapes.add_picture(str(png), 0, 0, Inches(SLIDE_W), Inches(SLIDE_H))
        return
    if bg == "FFFFFF" and not bg_to:
        return
    if bg_to:
        try:
            fill = slide.background.fill
            fill.gradient()
            stops = fill.gradient_stops
            stops[0].color.rgb = RGBColor(*hex_to_rgb(bg))
            stops[1].color.rgb = RGBColor(*hex_to_rgb(bg_to))
            try:
                fill.gradient_angle = 45.0
            except Exception:
                pass
            return
        except Exception:
            pass
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = RGBColor(*hex_to_rgb(bg))


def _display_color(accent):
    """Big display type: ink on dark backgrounds, accent on light ones."""
    return _ink() if _is_dark() else hex_to_rgb(accent or CURRENT["accent"])


def _add_header(slide, title, accent, top=0.35):
    header = _pptx_textbox(slide, 0.6, top, 12.1, 0.9)
    _set_runs(header.text_frame.paragraphs[0], title, 24, bold=True, color=hex_to_rgb(accent or CURRENT["accent"]))


def add_kicker(slide, text, accent=None, top=0.7):
    """Eyebrow label above the title: uppercase, letter-spaced, accent color."""
    box = _pptx_textbox(slide, 0.8, top, 11.7, 0.5)
    run = _set_runs(box.text_frame.paragraphs[0], text.upper(), 13, bold=True,
                    color=hex_to_rgb(accent or CURRENT["accent"]))
    run.font._rPr.set("spc", "300")
    return box


def _add_dash(slide, left=0.82, top=2.0, accent=None):
    """Short accent bar — the small horizontal rule seen under kickers."""
    from pptx.util import Inches, Pt
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_SHAPE
    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(left), Inches(top), Inches(0.55), Pt(5))
    bar.fill.solid()
    bar.fill.fore_color.rgb = RGBColor(*hex_to_rgb(accent or CURRENT["accent"]))
    bar.line.fill.background()
    bar.shadow.inherit = False
    return bar


def add_footer(slide, text, number=None):
    """Small muted footer line, optionally with a page number: 'Deck · 03'."""
    box = _pptx_textbox(slide, 0.8, 6.95, 11.7, 0.4)
    label = text if number is None else text + "   ·   " + str(number).zfill(2)
    _set_runs(box.text_frame.paragraphs[0], label, 10, color=_muted())
    return box


def _add_card(slide, left, top, width, height):
    from pptx.util import Inches, Pt
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_SHAPE
    card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(left), Inches(top), Inches(width), Inches(height))
    try:
        card.adjustments[0] = 0.06
    except Exception:
        pass
    card.fill.solid()
    card.fill.fore_color.rgb = RGBColor(*hex_to_rgb(CURRENT["surface"]))
    card.line.color.rgb = RGBColor(*hex_to_rgb(lighten(CURRENT["accent"], 0.45)))
    card.line.width = Pt(0.75)
    card.shadow.inherit = False
    return card


def _fill_bullets(frame, items, base_size=18):
    from pptx.util import Pt
    frame.word_wrap = True
    sizes = {0: base_size, 1: base_size - 2, 2: base_size - 4}
    for index, item in enumerate(items):
        level, text = item if isinstance(item, tuple) else (0, item)
        paragraph = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
        paragraph.level = min(level, 2)
        paragraph.space_after = Pt(6)
        _set_runs(paragraph, text, sizes.get(paragraph.level, 14))


def new_prs():
    pptx = require("pptx", "python-pptx")
    from pptx.util import Inches
    prs = pptx.Presentation()
    prs.slide_width = Inches(SLIDE_W)
    prs.slide_height = Inches(SLIDE_H)
    return prs


def add_title_slide(prs, title, subtitle="", kicker="", footer="", accent=None):
    accent = accent or CURRENT["accent"]
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _apply_bg(slide)
    if kicker:
        add_kicker(slide, kicker, accent)
    _add_dash(slide, top=2.05, accent=accent)
    box = _pptx_textbox(slide, 0.8, 2.3, 11.7, 1.8)
    _set_runs(box.text_frame.paragraphs[0], title, 40, bold=True, color=_display_color(accent))
    if subtitle:
        sub = _pptx_textbox(slide, 0.8, 4.3, 11.7, 0.9)
        _set_runs(sub.text_frame.paragraphs[0], subtitle, 16, color=_muted())
    if footer:
        add_footer(slide, footer)
    return slide


def add_agenda_slide(prs, items, accent=None):
    """Agenda with big accent numerals and hairline dividers."""
    from pptx.util import Inches, Pt
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_SHAPE
    accent = accent or CURRENT["accent"]
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _apply_bg(slide)
    _add_header(slide, "Agenda", accent)
    top = 1.9
    step = min(0.95, 4.8 / max(len(items), 1))
    for index, item in enumerate(items):
        y = top + index * step
        num = _pptx_textbox(slide, 1.0, y, 1.1, 0.75)
        _set_runs(num.text_frame.paragraphs[0], str(index + 1).zfill(2), 24, bold=True, color=hex_to_rgb(accent))
        row = _pptx_textbox(slide, 2.3, y + 0.06, 9.8, 0.6)
        _set_runs(row.text_frame.paragraphs[0], str(item), 18)
        if index < len(items) - 1:
            divider = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(2.3), Inches(y + step - 0.14), Inches(9.8), Pt(0.75))
            divider.fill.solid()
            divider.fill.fore_color.rgb = RGBColor(*hex_to_rgb(CURRENT["surface"]))
            divider.line.fill.background()
            divider.shadow.inherit = False
    return slide


def add_section_slide(prs, title, kicker="", accent=None):
    accent = accent or CURRENT["accent"]
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _apply_bg(slide)
    if kicker:
        add_kicker(slide, kicker, accent, top=2.5)
    _add_dash(slide, top=3.15, accent=accent)
    box = _pptx_textbox(slide, 0.8, 3.4, 11.7, 1.2)
    _set_runs(box.text_frame.paragraphs[0], title, 30, bold=True, color=_display_color(accent))
    return slide


def add_content_slide(prs, title, bullets, accent=None):
    """bullets: list of (level, text) tuples, level 0-2."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _apply_bg(slide)
    _add_header(slide, title, accent)
    body = _pptx_textbox(slide, 0.8, 1.5, 11.7, 5.4)
    _fill_bullets(body.text_frame, bullets)
    return slide


def add_two_column_slide(prs, title, left, right, accent=None):
    """Two bullet columns; left/right are (level, text) lists like add_content_slide."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _apply_bg(slide)
    _add_header(slide, title, accent)
    for column, items in enumerate((left, right)):
        box = _pptx_textbox(slide, 0.7 + column * 6.1, 1.5, 5.7, 5.4)
        _fill_bullets(box.text_frame, items, base_size=16)
    return slide


def add_cards_slide(prs, title, cards, kicker="", accent=None):
    """Rounded cards in a row. cards: (heading, desc) or (label, heading, desc)
    — pass a label like '01' for the big-numeral look."""
    accent = accent or CURRENT["accent"]
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _apply_bg(slide)
    if kicker:
        add_kicker(slide, kicker, accent, top=0.4)
        _add_header(slide, title, accent, top=0.85)
    else:
        _add_header(slide, title, accent)
    count = len(cards)
    margin, gap = 0.7, 0.35
    width = (SLIDE_W - 2 * margin - (count - 1) * gap) / count
    top, height = 2.15, 3.7
    for index, card in enumerate(cards):
        if len(card) == 2:
            label, heading, desc = None, card[0], card[1]
        else:
            label, heading, desc = card[0], card[1], card[2]
        left = margin + index * (width + gap)
        _add_card(slide, left, top, width, height)
        cursor = top + 0.35
        if label is not None:
            box = _pptx_textbox(slide, left + 0.32, cursor, width - 0.64, 0.8)
            _set_runs(box.text_frame.paragraphs[0], str(label), 26, bold=True, color=hex_to_rgb(accent))
            cursor += 0.95
        box = _pptx_textbox(slide, left + 0.32, cursor, width - 0.64, 0.7)
        _set_runs(box.text_frame.paragraphs[0], str(heading), 16, bold=True)
        body = _pptx_textbox(slide, left + 0.32, cursor + 0.75, width - 0.64, top + height - cursor - 1.0)
        frame = body.text_frame
        frame.word_wrap = True
        _set_runs(frame.paragraphs[0], str(desc), 12, color=_muted())
    return slide


def add_stats_slide(prs, title, stats, accent=None):
    """Big-number callouts in a row. stats: list of (value, label)."""
    from pptx.enum.text import PP_ALIGN
    accent = accent or CURRENT["accent"]
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _apply_bg(slide)
    _add_header(slide, title, accent)
    count = len(stats)
    margin = 0.7
    width = (SLIDE_W - 2 * margin) / count
    for index, item in enumerate(stats):
        value, label = item[0], item[1]
        left = margin + index * width
        box = _pptx_textbox(slide, left, 2.5, width, 1.3)
        paragraph = box.text_frame.paragraphs[0]
        paragraph.alignment = PP_ALIGN.CENTER
        _set_runs(paragraph, str(value), 40, bold=True, color=hex_to_rgb(accent))
        sub = _pptx_textbox(slide, left, 3.95, width, 0.6)
        sub_para = sub.text_frame.paragraphs[0]
        sub_para.alignment = PP_ALIGN.CENTER
        _set_runs(sub_para, str(label), 13, color=_muted())
    return slide


def add_table_slide(prs, title, rows, accent=None):
    """Styled table slide; rows[0] is the accent-filled header row."""
    accent = accent or CURRENT["accent"]
    from pptx.util import Inches, Pt
    from pptx.dml.color import RGBColor
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _apply_bg(slide)
    _add_header(slide, title, accent)
    height = Inches(0.45) * len(rows)
    frame = slide.shapes.add_table(len(rows), len(rows[0]), Inches(0.7), Inches(1.6), Inches(11.9), height)
    table = frame.table
    for r, row in enumerate(rows):
        for c, value in enumerate(row):
            cell = table.cell(r, c)
            cell.text = str(value)
            for paragraph in cell.text_frame.paragraphs:
                for run in paragraph.runs:
                    run.font.size = Pt(15 if r == 0 else 14)
                    run.font.bold = r == 0
                    run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF) if r == 0 else RGBColor(*_ink())
            if r == 0:
                cell.fill.solid()
                cell.fill.fore_color.rgb = RGBColor(*hex_to_rgb(accent))
            elif _is_dark():
                cell.fill.solid()
                cell.fill.fore_color.rgb = RGBColor(*hex_to_rgb(CURRENT["surface"]))
    return slide


def add_image_slide(prs, title, image_path, caption=None, accent=None):
    """Full-width image with an optional caption line."""
    from pptx.util import Inches
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _apply_bg(slide)
    _add_header(slide, title, accent)
    slide.shapes.add_picture(str(image_path), Inches(1.2), Inches(1.6), width=Inches(10.9))
    if caption:
        box = _pptx_textbox(slide, 1.2, 6.7, 10.9, 0.5)
        _set_runs(box.text_frame.paragraphs[0], caption, 12, color=_muted())
    return slide


def add_chart_slide(prs, title, categories, series, chart_type="bar", accent=None):
    """Native, editable chart. series: list of (name, values); type: bar|line|pie."""
    pptx = require("pptx", "python-pptx")
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from pptx.util import Inches
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _apply_bg(slide)
    _add_header(slide, title, accent)
    data = CategoryChartData()
    data.categories = list(categories)
    for name, values in series:
        data.add_series(name, list(values))
    kinds = {"bar": XL_CHART_TYPE.COLUMN_CLUSTERED, "line": XL_CHART_TYPE.LINE_MARKERS, "pie": XL_CHART_TYPE.PIE}
    frame = slide.shapes.add_chart(kinds.get(chart_type, XL_CHART_TYPE.COLUMN_CLUSTERED),
                                   Inches(1.0), Inches(1.6), Inches(11.3), Inches(5.2), data)
    chart = frame.chart
    chart.has_legend = len(series) > 1 or chart_type == "pie"
    from pptx.util import Pt
    from pptx.dml.color import RGBColor
    palette = [hex_to_rgb(accent or CURRENT["accent"]), hex_to_rgb(lighten(CURRENT["accent"], 0.35)), _muted()]
    for index, serie in enumerate(chart.plots[0].series):
        try:
            serie.format.fill.solid()
            serie.format.fill.fore_color.rgb = RGBColor(*palette[index % len(palette)])
        except Exception:
            pass
    if _is_dark():
        font_color = RGBColor(*_muted())
        try:
            chart.font.size = Pt(12)
            chart.font.name = CURRENT["latin"]
            chart.font.color.rgb = font_color
        except Exception:
            pass
        for axis in ("category_axis", "value_axis"):
            try:
                getattr(chart, axis).tick_labels.font.color.rgb = font_color
            except Exception:
                pass
    return slide


def add_quote_slide(prs, quote, attribution="", accent=None):
    """Big centered quotation with optional attribution."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _apply_bg(slide)
    box = _pptx_textbox(slide, 1.5, 2.6, 10.3, 2.2)
    frame = box.text_frame
    frame.word_wrap = True
    _set_runs(frame.paragraphs[0], "\"" + quote + "\"", 26, italic=True)
    if attribution:
        sub = _pptx_textbox(slide, 1.5, 5.0, 10.3, 0.7)
        _set_runs(sub.text_frame.paragraphs[0], "— " + attribution, 16, color=hex_to_rgb(accent or CURRENT["accent"]))
    return slide


def add_closing_slide(prs, title="Thank you", subtitle="", footer="", accent=None):
    """Closing slide mirroring the title slide."""
    accent = accent or CURRENT["accent"]
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _apply_bg(slide)
    _add_dash(slide, top=2.8, accent=accent)
    box = _pptx_textbox(slide, 0.8, 3.05, 11.7, 1.2)
    _set_runs(box.text_frame.paragraphs[0], title, 34, bold=True, color=_display_color(accent))
    if subtitle:
        sub = _pptx_textbox(slide, 0.8, 4.35, 11.7, 0.8)
        _set_runs(sub.text_frame.paragraphs[0], subtitle, 15, color=_muted())
    if footer:
        add_footer(slide, footer)
    return slide


def set_speaker_notes(slide, text):
    """Attach speaker notes (mandatory for slides carrying numbers or charts)."""
    slide.notes_slide.notes_text_frame.text = text
    return slide


def scaffold_pptx(out, title, subtitle, accent, demo, kicker="", footer=""):
    prs = new_prs()
    if CURRENT.get("glow"):
        assets = Path(out).parent / (Path(out).stem + ".assets")
        CURRENT["glowPng"] = make_glow_background(assets / "bg.png")
    add_title_slide(prs, title, subtitle, kicker=kicker, footer=footer, accent=accent)
    if demo:
        add_agenda_slide(prs, ["First topic", "Second topic", "Third topic"], accent)
        add_section_slide(prs, "Section title", kicker="PART 01", accent=accent)
        add_cards_slide(prs, "Three pillars",
                        [("01", "Fast", "Styled skeleton in a single command"),
                         ("02", "Designed", "Theme palette, cards, kickers, glow backgrounds"),
                         ("03", "Verified", "inspect audits every slide before shipping")],
                        kicker="WHY", accent=accent)
        add_content_slide(prs, "Slide title", [(0, "Key point one"), (1, "Supporting detail"), (0, "Key point two")], accent)
        add_two_column_slide(prs, "Two columns", [(0, "Left point"), (1, "Left detail")], [(0, "Right point"), (1, "Right detail")], accent)
        add_stats_slide(prs, "By the numbers", [("12", "layouts"), ("4", "themes"), ("0", "manual tweaks")], accent)
        add_table_slide(prs, "Table slide", [["Name", "Q1", "Q2"], ["Alpha", "10", "12"], ["Beta", "8", "15"]], accent)
        chart_slide = add_chart_slide(prs, "Chart slide", ["Q1", "Q2", "Q3", "Q4"], [("Alpha", (10, 12, 14, 16)), ("Beta", (8, 15, 11, 13))], "bar", accent)
        set_speaker_notes(chart_slide, "Demo numbers only — replace with real data and say what the trend means.")
        add_quote_slide(prs, "Simplicity is the soul of efficiency.", "Austin Freeman", accent)
        add_closing_slide(prs, "Thank you", subtitle, footer=footer, accent=accent)
    prs.save(str(out))
    note = "16:9 deck with title slide" + (" + one sample of every layout" if demo else "") + ". "
    if CURRENT.get("glow"):
        note += "Background: " + (CURRENT["glowPng"] or "native gradient (install pillow for the glow PNG)") + ". "
    note += "Extend via the add_*_slide helpers (import from office_scaffold). Max ~6 bullets per slide; set_speaker_notes on chart/number slides."
    return {"ok": True, "path": str(out), "note": note}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Generate styled Office skeletons")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("docx", "pptx"):
        p = sub.add_parser(name)
        p.add_argument("out")
        p.add_argument("--title", required=True)
        p.add_argument("--subtitle", default="")
        p.add_argument("--accent", default=None)
        p.add_argument("--latin-font", default=None)
        p.add_argument("--cjk-font", default=None)
    sub.choices["docx"].add_argument("--cover", action="store_true")
    sub.choices["docx"].add_argument("--toc", action="store_true")
    p_pptx = sub.choices["pptx"]
    p_pptx.add_argument("--bg", default=None)
    p_pptx.add_argument("--bg-to", default=None)
    p_pptx.add_argument("--glow", action="store_true")
    p_pptx.add_argument("--ink", default=None)
    p_pptx.add_argument("--muted", default=None)
    p_pptx.add_argument("--surface", default=None)
    p_pptx.add_argument("--kicker", default="")
    p_pptx.add_argument("--footer", default="")
    p_pptx.add_argument("--demo", action="store_true")
    args = parser.parse_args()

    tokens = {"accent": args.accent, "latin": args.latin_font, "cjk": args.cjk_font}
    if args.command == "pptx":
        tokens.update({"bg": args.bg, "bgTo": args.bg_to, "ink": args.ink,
                       "muted": args.muted, "surface": args.surface})
        if args.glow:
            tokens["glow"] = True
    set_style(**tokens)
    accent = CURRENT["accent"]
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if args.command == "docx":
        result = scaffold_docx(out, args.title, args.subtitle, accent, args.cover, args.toc)
    else:
        result = scaffold_pptx(out, args.title, args.subtitle, accent, args.demo, args.kicker, args.footer)
    result["style"] = {key: CURRENT[key] for key in DEFAULT_STYLE}
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
`;

export const XLSX_BUILD_PY = `#!/usr/bin/env python3
"""Build, style and verify professional Excel workbooks.

Usage:
  python xlsx_build.py new <out.xlsx> --sheets Data,Summary
  python xlsx_build.py import-csv <in.csv> <out.xlsx> [--sheet Data] [--accent 305496]
  python xlsx_build.py style <file.xlsx> [--sheet name] [--accent 305496] [--formats B:currency,C:percent] [--databar D]
  python xlsx_build.py add-chart <file.xlsx> --sheet Data --type bar|line|pie --data A1:B10 [--title "..."] [--at H2]
  python xlsx_build.py verify <file.xlsx>

Verification cross-checks: formulas are reported with their cached values so
you can compare against Python-side recomputation before shipping.
"""
import argparse
import csv
import importlib
import json
import sys
from pathlib import Path

NUMBER_FORMATS = {
    "currency": "\\"¥\\"#,##0.00",
    "usd": "\\"$\\"#,##0.00",
    "percent": "0.0%",
    "date": "yyyy-mm-dd",
    "int": "#,##0",
    "float": "#,##0.00"
}


def fail(message):
    print(json.dumps({"ok": False, "error": message}, indent=2))
    sys.exit(1)


def require(module, pip_name):
    try:
        return importlib.import_module(module)
    except ImportError:
        fail(
            "Missing dependency '" + pip_name + "'. Create an isolated environment first: "
            "python -m venv .venv, then .venv/Scripts/pip install " + pip_name + " (Windows) "
            "or .venv/bin/pip install " + pip_name + " (macOS/Linux), and re-run with that interpreter."
        )


def style_sheet(ws, accent="305496", header_row=1):
    """Header fill + bold, freeze top row, autofilter, content-sized columns."""
    openpyxl = require("openpyxl", "openpyxl")
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    fill = PatternFill("solid", fgColor=accent)
    font = Font(bold=True, color="FFFFFF", size=11)
    border = Border(bottom=Side(style="thin", color="B0B0B0"))
    for cell in ws[header_row]:
        if cell.value is None:
            continue
        cell.fill = fill
        cell.font = font
        cell.border = border
        cell.alignment = Alignment(vertical="center")
    ws.freeze_panes = ws.cell(row=header_row + 1, column=1).coordinate
    if ws.max_column and ws.max_row and ws.max_row > header_row:
        ws.auto_filter.ref = "A" + str(header_row) + ":" + ws.cell(row=ws.max_row, column=ws.max_column).coordinate
    for col in ws.iter_cols(min_row=header_row, max_row=min(ws.max_row, header_row + 200)):
        letter = col[0].column_letter
        width = max((len(str(cell.value)) for cell in col if cell.value is not None), default=8)
        ws.column_dimensions[letter].width = min(max(width * 1.15, 9), 60)
    return ws


def apply_formats(ws, spec, header_row=1):
    """Apply number-format presets. spec looks like 'B:currency,C:percent,D:date'."""
    from openpyxl.utils import column_index_from_string
    applied = {}
    for part in spec.split(","):
        if ":" not in part:
            fail("--formats entries look like B:currency,C:percent — bad entry: " + part)
        col, preset = part.split(":", 1)
        col = col.strip()
        preset = preset.strip()
        if preset not in NUMBER_FORMATS:
            fail("Unknown format preset '" + preset + "'. Choose from: " + ", ".join(sorted(NUMBER_FORMATS)))
        index = column_index_from_string(col) if col.isalpha() else int(col)
        count = 0
        for row in range(header_row + 1, ws.max_row + 1):
            cell = ws.cell(row=row, column=index)
            if cell.value is not None:
                cell.number_format = NUMBER_FORMATS[preset]
                count += 1
        applied[col] = {"preset": preset, "cells": count}
    return applied


def add_databar(ws, col, header_row=1, color="305496"):
    """Conditional-formatting data bars down one column."""
    from openpyxl.formatting.rule import DataBarRule
    from openpyxl.utils import column_index_from_string, get_column_letter
    index = column_index_from_string(col) if col.isalpha() else int(col)
    letter = get_column_letter(index)
    ref = letter + str(header_row + 1) + ":" + letter + str(ws.max_row)
    rule = DataBarRule(start_type="min", end_type="max", color=color, showValue=True)
    ws.conditional_formatting.add(ref, rule)
    return ref


def _coerce(value):
    text = value.strip()
    if text == "":
        return None
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        return value


def cmd_new(args):
    openpyxl = require("openpyxl", "openpyxl")
    names = [name.strip() for name in args.sheets.split(",") if name.strip()]
    if not names:
        fail("--sheets must list at least one sheet name")
    wb = openpyxl.Workbook()
    wb.active.title = names[0]
    for name in names[1:]:
        wb.create_sheet(name)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(out))
    return {"ok": True, "path": str(out), "sheets": names,
            "note": "Write data with openpyxl, then run: python xlsx_build.py style " + str(out)}


def cmd_import_csv(args):
    openpyxl = require("openpyxl", "openpyxl")
    src = Path(args.csv)
    if not src.is_file():
        fail("File not found: " + str(src))
    rows = []
    with src.open(newline="", encoding="utf-8-sig") as handle:
        for record in csv.reader(handle):
            rows.append([_coerce(value) for value in record])
    if not rows:
        fail("CSV is empty: " + str(src))
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = args.sheet
    for row in rows:
        ws.append(row)
    style_sheet(ws, accent=args.accent)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(out))
    return {"ok": True, "path": str(out), "sheet": args.sheet, "rows": len(rows), "cols": max(len(r) for r in rows),
            "note": "Imported and styled. Add formats/charts next, then: python xlsx_build.py verify " + str(out)}


def cmd_style(args):
    openpyxl = require("openpyxl", "openpyxl")
    path = Path(args.file)
    if not path.is_file():
        fail("File not found: " + str(path))
    wb = openpyxl.load_workbook(str(path))
    targets = [args.sheet] if args.sheet else wb.sheetnames
    result = {"ok": True, "path": str(path), "styled": targets}
    for name in targets:
        if name not in wb.sheetnames:
            fail("No such sheet: " + name)
        ws = wb[name]
        style_sheet(ws, accent=args.accent)
        if args.formats:
            result.setdefault("formats", {})[name] = apply_formats(ws, args.formats)
        if args.databar:
            result.setdefault("databars", {})[name] = add_databar(ws, args.databar, color=args.accent)
    wb.save(str(path))
    return result


def cmd_add_chart(args):
    openpyxl = require("openpyxl", "openpyxl")
    from openpyxl.chart import BarChart, LineChart, PieChart, Reference
    from openpyxl.utils.cell import range_boundaries
    path = Path(args.file)
    if not path.is_file():
        fail("File not found: " + str(path))
    wb = openpyxl.load_workbook(str(path))
    if args.sheet not in wb.sheetnames:
        fail("No such sheet: " + args.sheet)
    ws = wb[args.sheet]
    try:
        min_col, min_row, max_col, max_row = range_boundaries(args.data)
    except ValueError:
        fail("--data must be a range like A1:B10, got: " + args.data)
    if max_col - min_col < 1:
        fail("--data needs at least two columns: categories first, values second (A1:B10)")
    values = Reference(ws, min_col=min_col + 1, min_row=min_row, max_col=max_col, max_row=max_row)
    categories = Reference(ws, min_col=min_col, min_row=min_row + 1, max_row=max_row)
    chart = {"bar": BarChart, "line": LineChart, "pie": PieChart}[args.type]()
    chart.title = args.title
    chart.add_data(values, titles_from_data=True)
    chart.set_categories(categories)
    ws.add_chart(chart, args.at)
    wb.save(str(path))
    return {"ok": True, "path": str(path), "sheet": args.sheet, "type": args.type,
            "data": args.data, "anchor": args.at,
            "note": "Charts do not survive load_workbook round-trips — add charts after all other edits."}


def cmd_verify(args):
    openpyxl = require("openpyxl", "openpyxl")
    path = Path(args.file)
    if not path.is_file():
        fail("File not found: " + str(path))
    wb = openpyxl.load_workbook(str(path), data_only=False)
    wb_values = openpyxl.load_workbook(str(path), data_only=True)
    issues = []
    sheets = []
    for name in wb.sheetnames:
        ws = wb[name]
        ws_values = wb_values[name]
        formulas = []
        formatted = 0
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and cell.value.startswith("="):
                    formulas.append({"cell": cell.coordinate, "formula": cell.value[:80],
                                     "cached": ws_values[cell.coordinate].value})
                if cell.value is not None and cell.number_format != "General":
                    formatted += 1
        uncached = [f["cell"] for f in formulas if f["cached"] is None]
        if uncached:
            issues.append("Sheet '" + name + "': " + str(len(uncached)) + " formula(s) without cached values — open once in Excel/LibreOffice or check inputs")
        if ws.max_row > 1 and ws.freeze_panes is None:
            issues.append("Sheet '" + name + "': top row not frozen (run style)")
        blank_rows = []
        if ws.max_row > 1:
            for row in ws.iter_rows(min_row=2):
                if all(cell.value is None for cell in row):
                    blank_rows.append(row[0].row)
        if blank_rows:
            issues.append("Sheet '" + name + "': " + str(len(blank_rows)) + " fully blank row(s) inside the used range (rows " + ",".join(str(r) for r in blank_rows[:8]) + ")")
        sheets.append({"name": name, "rows": ws.max_row, "cols": ws.max_column,
                       "freeze": ws.freeze_panes, "autoFilter": ws.auto_filter.ref,
                       "formulas": len(formulas), "formulaSample": formulas[:12],
                       "mergedCells": len(ws.merged_cells.ranges), "blankRows": blank_rows[:20],
                       "formattedCells": formatted, "charts": len(getattr(ws, "_charts", []))})
    result = {"ok": not issues, "file": str(path), "sheets": sheets, "issues": issues}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    sys.exit(0 if result["ok"] else 1)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Build, style and verify xlsx workbooks")
    sub = parser.add_subparsers(dest="command", required=True)
    p_new = sub.add_parser("new")
    p_new.add_argument("out")
    p_new.add_argument("--sheets", required=True)
    p_import = sub.add_parser("import-csv")
    p_import.add_argument("csv")
    p_import.add_argument("out")
    p_import.add_argument("--sheet", default="Data")
    p_import.add_argument("--accent", default="305496")
    p_style = sub.add_parser("style")
    p_style.add_argument("file")
    p_style.add_argument("--sheet")
    p_style.add_argument("--accent", default="305496")
    p_style.add_argument("--formats", help="column:preset pairs, e.g. B:currency,C:percent")
    p_style.add_argument("--databar", help="column letter to add data bars, e.g. D")
    p_chart = sub.add_parser("add-chart")
    p_chart.add_argument("file")
    p_chart.add_argument("--sheet", required=True)
    p_chart.add_argument("--type", required=True, choices=["bar", "line", "pie"])
    p_chart.add_argument("--data", required=True, help="range, categories first col: A1:B10")
    p_chart.add_argument("--title", default="")
    p_chart.add_argument("--at", default="H2", help="anchor cell for the chart")
    p_verify = sub.add_parser("verify")
    p_verify.add_argument("file")
    args = parser.parse_args()
    handlers = {"new": cmd_new, "import-csv": cmd_import_csv, "style": cmd_style,
                "add-chart": cmd_add_chart, "verify": cmd_verify}
    result = handlers[args.command](args)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
`;

/** Scripts each built-in skill ships, keyed by capability id then relative path. */
export const BUILTIN_SKILL_SCRIPTS: Record<string, Record<string, string>> = {
  "builtin-office-documents": {
    "scripts/render_verify.py": RENDER_VERIFY_PY,
    "scripts/office_scaffold.py": OFFICE_SCAFFOLD_PY
  },
  "builtin-office-spreadsheets": {
    "scripts/render_verify.py": RENDER_VERIFY_PY,
    "scripts/xlsx_build.py": XLSX_BUILD_PY
  },
  "builtin-office-presentations": {
    "scripts/render_verify.py": RENDER_VERIFY_PY,
    "scripts/office_scaffold.py": OFFICE_SCAFFOLD_PY
  },
  "builtin-office-research": {
    "scripts/render_verify.py": RENDER_VERIFY_PY
  }
};
