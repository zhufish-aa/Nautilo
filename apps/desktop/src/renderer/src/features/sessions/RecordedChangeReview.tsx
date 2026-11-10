import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { DiffReviewNavigation, DiffReviewPosition } from "../../components/ui/DiffCodeEditor";
import type { ChangedFileEntry } from "../../lib/changed-files";
import { diffLines } from "../../lib/line-diff";
import { highlightLine, languageForPath } from "../../lib/highlight";
import { parseUnifiedHunks } from "../../lib/revert-change";
import { useProgressiveRows } from "../../lib/use-progressive-rows";
import { useI18n } from "../../lib/i18n";

interface RecordedLine { text: string; number?: number; kind: "same" | "removed" | "added" }
interface RecordedRow { key: string; chunk: number; left?: RecordedLine; right?: RecordedLine; heading?: string }

/** A patch remains a set of recorded hunks when a live baseline cannot be reconstructed. */
export function RecordedChangeReview({ entry, sideBySide, navigationRef, onReviewPosition }: {
  entry: ChangedFileEntry;
  sideBySide: boolean;
  navigationRef: MutableRefObject<DiffReviewNavigation | null>;
  onReviewPosition: (position: DiffReviewPosition) => void;
}): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const language = languageForPath(entry.path);
  const chunks = useMemo(() => entry.kind === "patch" ? parseUnifiedHunks(entry.diff ?? "").map(hunk => ({
    before: hunk.preImage.join("\n"), after: hunk.postImage.join("\n"), oldLine: hunk.preHintLine, newLine: hunk.hintLine,
    heading: `@@ −${hunk.preHintLine},${hunk.preImage.length} +${hunk.hintLine},${hunk.postImage.length} @@`
  })) : entry.diffs.map((fragment, index) => ({
    before: fragment.before, after: fragment.after, oldLine: undefined, newLine: undefined,
    heading: `${zh ? "修改记录" : "Recorded edit"} ${index + 1}${fragment.truncated ? (zh ? " · 已截断" : " · Truncated") : ""}`
  })), [entry, zh]);
  const rows = useMemo(() => {
    const result: RecordedRow[] = [];
    for (let chunk = 0; chunk < chunks.length; chunk += 1) {
      const source = chunks[chunk];
      result.push({ key: `${chunk}:heading`, chunk, heading: source.heading });
      let oldLine = source.oldLine;
      let newLine = source.newLine;
      let removed: RecordedLine[] = [];
      let added: RecordedLine[] = [];
      const flush = (): void => {
        if (sideBySide) for (let index = 0; index < Math.max(removed.length, added.length); index += 1) result.push({ key: `${chunk}:${result.length}`, chunk, left: removed[index], right: added[index] });
        else { for (const line of removed) result.push({ key: `${chunk}:${result.length}`, chunk, left: line }); for (const line of added) result.push({ key: `${chunk}:${result.length}`, chunk, right: line }); }
        removed = []; added = [];
      };
      for (const row of diffLines(source.before, source.after)) {
        // An empty side represents zero lines, not a fabricated blank addition/deletion.
        if (row.text === "" && ((row.type === "removed" && source.before === "") || (row.type === "added" && source.after === ""))) continue;
        if (row.type === "same") {
          flush(); result.push({ key: `${chunk}:${result.length}`, chunk, left: { text: row.text, number: oldLine, kind: "same" }, right: { text: row.text, number: newLine, kind: "same" } });
          if (oldLine !== undefined) oldLine += 1;
          if (newLine !== undefined) newLine += 1;
        } else if (row.type === "removed") { removed.push({ text: row.text, number: oldLine, kind: "removed" }); if (oldLine !== undefined) oldLine += 1; }
        else { added.push({ text: row.text, number: newLine, kind: "added" }); if (newLine !== undefined) newLine += 1; }
      }
      flush();
    }
    return result;
  }, [chunks, sideBySide]);
  const { limit, sentinelRef, showAll } = useProgressiveRows(rows.length, rows);
  const callbacks = useRef({ showAll, onReviewPosition });
  callbacks.current = { showAll, onReviewPosition };
  const count = chunks.length;
  useEffect(() => {
    callbacks.current.onReviewPosition({ index: count ? active + 1 : 0, count });
    navigationRef.current = { move(direction) {
      const next = (active + direction + count) % count;
      if (!count) return;
      callbacks.current.showAll(); setActive(next);
      requestAnimationFrame(() => scrollRef.current?.querySelector(`[data-review-chunk="${next}"]`)?.scrollIntoView({ block: "center" }));
    } };
    return () => { navigationRef.current = null; };
  }, [active, count, navigationRef]);

  const line = (value?: RecordedLine): JSX.Element => <div className={`review-recorded-line ${value?.kind ?? "blank"}`}><span className="recorded-line-number">{value?.number ?? ""}</span><span className="recorded-line-indicator">{value?.kind === "removed" ? "−" : value?.kind === "added" ? "+" : ""}</span><code dangerouslySetInnerHTML={{ __html: value ? highlightLine(value.text || " ", language) : " " }}/></div>;
  if (entry.kind === "patch" && entry.comparisonUnavailable) return <p role="status" className="review-recorded-notice">{zh ? "此文件未采集或无法读取，对比结果未知。" : "No captured baseline is available for this file."}</p>;
  if (!rows.length) return <p className="review-recorded-notice">{zh ? "没有可查看的差异详情" : "No diff details available"}</p>;
  return <div className="review-recorded-lines" ref={scrollRef}>
    {rows.slice(0, limit).map(row => row.heading ? <div className="review-hunk-heading" data-review-chunk={row.chunk} key={row.key}>{row.heading}</div> : sideBySide ? <div className="review-recorded-pair" key={row.key}>{line(row.left)}<span aria-hidden/>{line(row.right)}</div> : <div className="review-recorded-unified" key={row.key}>{line(row.right ?? row.left)}</div>)}
    {limit < rows.length && <button type="button" ref={sentinelRef} className="review-load-records" onClick={showAll}>{zh ? `展开剩余 ${rows.length - limit} 行` : `Show ${rows.length - limit} more lines`}</button>}
  </div>;
}
