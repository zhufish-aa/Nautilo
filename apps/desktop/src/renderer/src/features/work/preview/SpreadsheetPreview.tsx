import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../lib/i18n";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../lib/utils";
import { classifyPreviewError, planVisibleRange } from "../../../lib/work-preview";
import type { OfficePreviewProps } from "./types";

const ROW_CHUNK = 200;
const MAX_COLUMNS = 100;

interface MergeInfo {
  /** "r:c" of the anchor cell → span. */
  anchors: Map<string, { rowSpan: number; colSpan: number }>;
  /** "r:c" of every covered (non-anchor) cell. */
  covered: Set<string>;
}

interface SheetModel {
  name: string;
  rows: string[][];
  columnCount: number;
  columnsTruncated: boolean;
  merges: MergeInfo;
}

type Workbook = import("xlsx").WorkBook;

function columnLabel(index: number): string {
  let label = "";
  let value = index + 1;
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function buildSheetModel(XLSX: typeof import("xlsx"), workbook: Workbook, sheetIndex: number): SheetModel {
  const name = workbook.SheetNames[sheetIndex] ?? `#${sheetIndex + 1}`;
  const sheet = workbook.Sheets[name];
  if (!sheet || !sheet["!ref"]) {
    return { name, rows: [], columnCount: 0, columnsTruncated: false, merges: { anchors: new Map(), covered: new Set() } };
  }
  // raw:false renders each cell's cached/formatted text (formula results and
  // number formats included); no HTML is ever produced from the workbook.
  const grid = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" });
  const fullWidth = grid.reduce((width, row) => Math.max(width, row.length), 0);
  const columnCount = Math.min(fullWidth, MAX_COLUMNS);
  const rows = grid.map((row) => row.slice(0, columnCount).map((cell) => (cell == null ? "" : String(cell))));

  const anchors = new Map<string, { rowSpan: number; colSpan: number }>();
  const covered = new Set<string>();
  for (const merge of sheet["!merges"] ?? []) {
    const rowSpan = merge.e.r - merge.s.r + 1;
    const colSpan = Math.min(merge.e.c, columnCount - 1) - merge.s.c + 1;
    if (merge.s.c >= columnCount || rowSpan < 1 || colSpan < 1) continue;
    anchors.set(`${merge.s.r}:${merge.s.c}`, { rowSpan, colSpan });
    for (let r = merge.s.r; r <= merge.e.r; r += 1) {
      for (let c = merge.s.c; c <= Math.min(merge.e.c, columnCount - 1); c += 1) {
        if (r !== merge.s.r || c !== merge.s.c) covered.add(`${r}:${c}`);
      }
    }
  }
  return { name, rows, columnCount, columnsTruncated: fullWidth > MAX_COLUMNS, merges: { anchors, covered } };
}

/**
 * XLS/XLSX preview rendered as a safe React table — SheetJS only supplies
 * values, never HTML. Supports sheet tabs, merged cells, sticky letter/number
 * headers, two-axis scrolling and chunked rows for very large sheets.
 */
export function SpreadsheetPreview({ bytes, zoom, onNav, onReady, onError }: OfficePreviewProps): JSX.Element {
  const { t } = useI18n();
  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const [XLSX, setXLSX] = useState<typeof import("xlsx") | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [renderedRows, setRenderedRows] = useState(ROW_CHUNK);

  useEffect(() => {
    let cancelled = false;
    setWorkbook(null);
    setSheetIndex(0);
    setRenderedRows(ROW_CHUNK);
    void (async () => {
      try {
        const xlsxModule = await import("xlsx");
        if (cancelled) return;
        const parsed = xlsxModule.read(bytes, { type: "array" });
        if (cancelled) return;
        setXLSX(() => xlsxModule);
        setWorkbook(parsed);
      } catch (error) {
        if (cancelled) return;
        const name = error instanceof Error ? error.name : "";
        onError(error instanceof Error ? error.message : String(error), classifyPreviewError(name || "parse"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes, onError]);

  const sheet = useMemo(
    () => (workbook && XLSX ? buildSheetModel(XLSX, workbook, sheetIndex) : null),
    [workbook, XLSX, sheetIndex]
  );

  const range = useMemo(
    () => planVisibleRange(sheet?.rows.length ?? 0, renderedRows, ROW_CHUNK),
    [sheet, renderedRows]
  );

  // Ready once the current sheet model exists.
  useEffect(() => {
    if (sheet) onReady();
  }, [sheet, onReady]);

  // Publish sheet navigation to the unified toolbar.
  useEffect(() => {
    if (!workbook || workbook.SheetNames.length === 0) {
      onNav(null);
      return;
    }
    const count = workbook.SheetNames.length;
    onNav({
      kind: "sheet",
      index: Math.min(sheetIndex, count - 1),
      count,
      prev: () => setSheetIndex((current) => Math.max(0, current - 1)),
      next: () => setSheetIndex((current) => Math.min(count - 1, current + 1)),
      goto: (index) => setSheetIndex(Math.min(count - 1, Math.max(0, index)))
    });
    return () => onNav(null);
  }, [workbook, sheetIndex, onNav]);

  const scale = zoom === "fit-width" ? 1 : zoom / 100;

  if (!sheet) {
    return <div className="h-full bg-card/40" aria-busy />;
  }

  const selectSheet = (index: number): void => {
    setSheetIndex(index);
    setRenderedRows(ROW_CHUNK);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {workbook && workbook.SheetNames.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line/70 px-2 py-1">
          {workbook.SheetNames.map((name, index) => (
            <button
              key={name}
              type="button"
              onClick={() => selectSheet(index)}
              title={name}
              className={cn(
                "h-6 shrink-0 rounded-md px-2 text-[11px] font-medium transition-colors",
                index === sheetIndex ? "bg-accent-soft text-accent" : "text-ink-3 hover:bg-card-hover hover:text-ink"
              )}
            >
              <span className="max-w-28 truncate">{name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto bg-card/40">
        {sheet.rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-ink-3">
            {t("work.preview.sheetEmpty")}
          </div>
        ) : (
          <div className="inline-block p-3" style={{ zoom: scale }}>
            <table className="border-collapse bg-panel text-[12px] text-ink-2">
              <thead className="sticky top-0 z-20">
                <tr>
                  <th className="sticky left-0 z-30 border border-line bg-card-hover px-2 py-1 text-[10px] font-normal text-ink-3" />
                  {Array.from({ length: sheet.columnCount }, (_, column) => (
                    <th
                      key={column}
                      className="min-w-16 border border-line bg-card-hover px-2 py-1 text-[10px] font-medium text-ink-3"
                    >
                      {columnLabel(column)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.slice(range.start, range.end).map((row, offset) => {
                  const rowIndex = range.start + offset;
                  return (
                    <tr key={rowIndex}>
                      <th className="sticky left-0 z-10 border border-line bg-card-hover px-2 py-0.5 text-right text-[10px] font-normal text-ink-3">
                        {rowIndex + 1}
                      </th>
                      {Array.from({ length: sheet.columnCount }, (_, column) => {
                        if (sheet.merges.covered.has(`${rowIndex}:${column}`)) return null;
                        const span = sheet.merges.anchors.get(`${rowIndex}:${column}`);
                        return (
                          <td
                            key={column}
                            rowSpan={span?.rowSpan}
                            colSpan={span && span.colSpan > 1 ? span.colSpan : undefined}
                            className="max-w-72 truncate border border-line px-2 py-0.5 align-top"
                            title={row[column]}
                          >
                            {row[column] ?? ""}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {(range.truncated || sheet.columnsTruncated) && (
              <div className="sticky left-0 mt-2 flex items-center gap-3 text-[11px] text-ink-3">
                <span>
                  {t("work.preview.sheetTruncated", {
                    shown: range.end,
                    total: sheet.rows.length
                  })}
                </span>
                {range.truncated && (
                  <Button variant="outline" size="sm" onClick={() => setRenderedRows((current) => current + ROW_CHUNK)}>
                    {t("work.preview.sheetLoadMore")}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
