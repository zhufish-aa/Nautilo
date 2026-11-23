import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { cn } from "../../lib/utils";
import "./SlidingTabs.css";

export function SlidingTabs<T extends string>({ value, items, onChange, label, className, tablist = false }: {
  value: T;
  items: ReadonlyArray<{ id: T; label: string; count?: number; warning?: boolean }>;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  tablist?: boolean;
}): JSX.Element {
  const list = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const bar = list.current;
    const line = indicator.current;
    if (!bar || !line) return;
    const sync = () => {
      const active = bar.querySelector<HTMLButtonElement>('button:is([aria-pressed="true"], [aria-selected="true"])');
      if (!active) return;
      line.style.transform = 'translate(' + active.offsetLeft + 'px, ' + (active.offsetTop + active.offsetHeight - 2) + 'px) scaleX(' + active.offsetWidth / 100 + ')';
      line.style.opacity = "1";
    };
    sync();
    const observer = new ResizeObserver(sync);
    bar.querySelectorAll("button").forEach(button => observer.observe(button));
    observer.observe(bar);
    return () => observer.disconnect();
  }, [value, items.length]);

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!tablist || !keys.includes(event.key)) return;
    event.preventDefault();
    const current = items.findIndex(item => item.id === value);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    onChange(items[next].id);
    list.current?.querySelectorAll("button")[next]?.focus();
  };

  return <div className={cn("sliding-tabs", className)} ref={list}
    role={tablist ? "tablist" : "group"} aria-label={label} onKeyDown={move}>
    {items.map(item => <button type="button" key={item.id}
      role={tablist ? "tab" : undefined} aria-selected={tablist ? value === item.id : undefined}
      aria-pressed={!tablist ? value === item.id : undefined}
      tabIndex={tablist && value !== item.id ? -1 : undefined}
      data-missing={item.warning || undefined} onClick={() => onChange(item.id)}>
      {item.label}{item.count !== undefined && <span>{item.count}</span>}
    </button>)}
    <span className="sliding-tabs-indicator" ref={indicator} aria-hidden />
  </div>;
}
