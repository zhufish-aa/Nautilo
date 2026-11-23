import { useEffect, useMemo, useRef, useState } from "react";
import { Grid2X2, Minus, Plus } from "lucide-react";

export function ImageFilePreview({ url, path, zh }: { url: string; path: string; zh: boolean }): JSX.Element {
  const surface = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const [checker, setChecker] = useState(false);
  const [zoom, setZoom] = useState<number>();
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number }>();
  const fit = size.width && size.height ? Math.min(1, (available.width - 28) / size.width, (available.height - 28) / size.height) : 1;
  const scale = zoom ?? Math.max(.01, fit);
  const changeZoom = (factor: number): void => setZoom(value => Math.min(16, Math.max(.01, (value ?? scale) * factor)));

  useEffect(() => {
    const node = surface.current!;
    const observer = new ResizeObserver(() => setAvailable({ width: node.clientWidth, height: node.clientHeight }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = surface.current!;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      setZoom(value => Math.min(16, Math.max(.01, (value ?? scale) * Math.exp(-event.deltaY * .002))));
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [scale]);

  return <div className="preview-image-card">
    <div className="preview-image-stage" ref={surface} data-checker={checker}
      onPointerDown={event => {
        if (event.button !== 0) return;
        drag.current = { x: event.clientX - offset.x, y: event.clientY - offset.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => { if (drag.current) setOffset({ x: event.clientX - drag.current.x, y: event.clientY - drag.current.y }); }}
      onLostPointerCapture={() => { drag.current = undefined; }}>
      <img src={url} alt={path} draggable={false} onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        style={{ width: size.width || undefined, height: size.height || undefined, transform: "translate(" + offset.x + "px," + offset.y + "px) scale(" + scale + ")" }} />
    </div>
    <div className="preview-image-controls">
      <span className="preview-metadata">{size.width > 0 && size.width + " × " + size.height}</span>
      <div className="preview-group">
        <button type="button" className="preview-tool" onClick={() => changeZoom(1 / 1.2)} title={zh ? "缩小" : "Zoom out"} aria-label={zh ? "缩小" : "Zoom out"}><Minus size={14}/></button>
        <span className="preview-metadata">{Math.round(scale * 100)}%</span>
        <button type="button" className="preview-tool" onClick={() => changeZoom(1.2)} title={zh ? "放大" : "Zoom in"} aria-label={zh ? "放大" : "Zoom in"}><Plus size={14}/></button>
        <button type="button" className="preview-tool" onClick={() => { setZoom(undefined); setOffset({ x: 0, y: 0 }); }}>{zh ? "适配" : "Fit"}</button>
        <button type="button" className="preview-tool" onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}>1:1</button>
        <button type="button" className="preview-tool" aria-pressed={checker} onClick={() => setChecker(!checker)} title={zh ? "透明棋盘格" : "Transparency grid"} aria-label={zh ? "透明棋盘格" : "Transparency grid"}><Grid2X2 size={14}/></button>
      </div>
    </div>
  </div>;
}

export function parseDelimited(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"' && (quoted || !field)) {
      if (quoted && text[index + 1] === '"') { field += char; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && (char === separator || char === "\n" || char === "\r")) {
      row.push(field);
      field = "";
      if (char !== separator) {
        rows.push(row);
        row = [];
        if (char === "\r" && text[index + 1] === "\n") index += 1;
      }
    } else field += char;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

export function DelimitedFilePreview({ text, path }: { text: string; path: string }): JSX.Element {
  const [dataStart, setDataStart] = useState(0);
  const rows = useMemo(() => parseDelimited(text, /\.tsv$/i.test(path) ? "\t" : ","), [path, text]);
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const start = Math.min(dataStart, Math.max(rows.length - 1, 0));
  const end = Math.min(rows.length - 1, start + 110);
  return <div className="preview-table-card"
    onScroll={event => setDataStart(Math.max(0, Math.floor(event.currentTarget.scrollTop / 29) - 20))}>
    <table>
      <thead><tr>{Array.from({ length: columns }, (_, index) => <th key={index}>{rows[0]?.[index]}</th>)}</tr></thead>
      <tbody>
        {start > 0 && <tr aria-hidden style={{ height: start * 29 }}><td colSpan={columns}/></tr>}
        {rows.slice(start + 1, end + 1).map((row, index) => <tr key={start + index} data-alt={(start + index) % 2 === 1}>
          {Array.from({ length: columns }, (_, column) => <td key={column} title={row[column]}>{row[column]}</td>)}
        </tr>)}
        {end < rows.length - 1 && <tr aria-hidden style={{ height: (rows.length - 1 - end) * 29 }}><td colSpan={columns}/></tr>}
      </tbody>
    </table>
  </div>;
}
