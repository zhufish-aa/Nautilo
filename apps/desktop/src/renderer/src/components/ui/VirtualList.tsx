import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

export type ListPosition = { key: string; offset: number };
type Row = { key: string; render: () => ReactNode; size?: number };

/** A single scroll surface, including group headers. Off-screen keyboard
 * destinations are measured before receiving focus. No entry effects on replay. */
export function VirtualList({ rows, className, position, onPosition, label, keyboard = false }: {
  rows: Row[]; className?: string; position?: ListPosition; onPosition?: (value: ListPosition) => void;
  label?: string; keyboard?: boolean;
}): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const pending = useRef<{ key: string; focus?: boolean; offset?: number } | undefined>(position);
  const initial = useRef(position);
  const callbacks = useRef({ rows, onPosition }); callbacks.current = { rows, onPosition };
  const keys = useMemo(() => rows.map(row => row.key), [rows]);
  const virtual = rows.length > 60;
  const list = useVirtualizer({ count: rows.length, getScrollElement: () => viewport.current,
    getItemKey: index => keys[index], estimateSize: index => rows[index]?.size ?? 36,
    initialOffset: () => Math.max(0, keys.indexOf(initial.current?.key ?? "")) * 36,
    overscan: 5, enabled: virtual, useFlushSync: false });
  const visible = list.getVirtualItems();
  useLayoutEffect(() => {
    const target = pending.current;
    const element = viewport.current;
    if (!target || !element) return;
    const index = keys.indexOf(target.key);
    if (index < 0) { pending.current = undefined; return; }
    const row = element.querySelector<HTMLElement>(`[data-list-index="${index}"]`);
    if (!row) { if (virtual) list.scrollToIndex(index, { align: "auto" }); return; }
    if (target.focus) row.querySelector<HTMLElement>("[data-list-action],button:not(:disabled)")?.focus({ preventScroll: true });
    else element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top + (target.offset ?? 0);
    pending.current = undefined;
  }, [keys, visible[0]?.index, visible.at(-1)?.index, virtual, list]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = (): void => {
      const top = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll<HTMLElement>("[data-list-index]")].find(item => item.getBoundingClientRect().bottom > top + 1);
      const key = row && callbacks.current.rows[Number(row.dataset.listIndex)]?.key;
      if (key && row) callbacks.current.onPosition?.({ key, offset: Math.max(0, top - row.getBoundingClientRect().top) });
    };
    const scroll = (): void => { clearTimeout(timer); timer = setTimeout(save, 160); };
    element.addEventListener("scroll", scroll, { passive: true });
    return () => { clearTimeout(timer); save(); element.removeEventListener("scroll", scroll); };
  }, []);
  return <div ref={viewport} className={className} role="list" aria-label={label} style={{ overflowAnchor: "none" }}
    onKeyDown={event => {
      if (!keyboard || event.altKey || event.metaKey || event.ctrlKey || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      if ((event.target as HTMLElement).matches("input,textarea,select")) return;
      const current = Number((event.target as HTMLElement).closest<HTMLElement>("[data-list-index]")?.dataset.listIndex ?? 0);
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
      if (!rows[next]) return;
      event.preventDefault(); pending.current = { key: rows[next].key, focus: true };
      if (virtual) list.scrollToIndex(next, { align: "auto" });
      requestAnimationFrame(() => {
        const row = viewport.current?.querySelector<HTMLElement>(`[data-list-index="${next}"]`);
        if (row) { row.scrollIntoView({ block: "nearest" }); row.querySelector<HTMLElement>("[data-list-action],button:not(:disabled)")?.focus({ preventScroll: true }); pending.current = undefined; }
      });
    }}>
    <div style={{ position: "relative", height: virtual ? list.getTotalSize() : undefined }}>
      {(virtual ? visible : rows.map((row, index) => ({ key: row.key, index, start: 0 }))).map(item => <div key={item.key} role="listitem" data-index={item.index} data-list-index={item.index}
        ref={virtual ? list.measureElement : undefined} style={virtual ? { position: "absolute", width: "100%", top: 0, transform: `translateY(${item.start}px)` } : undefined}>
        {rows[item.index]?.render()}
      </div>)}
    </div>
  </div>;
}
