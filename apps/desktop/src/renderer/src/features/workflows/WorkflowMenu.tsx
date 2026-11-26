import { useLayoutEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import type { Point } from "./workflow-geometry";

export interface MenuAction {
  label: string;
  icon: LucideIcon;
  action(): void;
  shortcut?: string;
  secondary?: boolean;
  dangerous?: boolean;
}

export function WorkflowMenu({ title, anchor, actions, close, searchable }: {
  title: string; anchor: Point; actions: MenuAction[]; close(restore?: boolean): void; searchable?: boolean;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(anchor);
  const [query, setQuery] = useState("");
  const filtered = actions.filter(action => action.label.toLowerCase().includes(query.trim().toLowerCase()));
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element?.parentElement) return;
    const { clientWidth, clientHeight } = element.parentElement;
    setPosition({
      x: Math.max(8, Math.min(anchor.x, clientWidth - element.offsetWidth - 8)),
      y: Math.max(8, Math.min(anchor.y, clientHeight - element.offsetHeight - 8)),
    });
    element.querySelector<HTMLElement>("input,button")?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent): void => {
      if (!element.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [anchor.x, anchor.y, title, close]);
  return <div ref={menu} className="wf-context-menu" role="menu" aria-label={title} style={{ left: position.x, top: position.y }}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      if (event.key === "Enter" && event.target instanceof HTMLInputElement && filtered.length) { event.preventDefault(); filtered[0].action(); return; }
      if (!["ArrowUp", "ArrowDown", "Home", "End", "Escape", "Tab"].includes(event.key)) return;
      if (event.target instanceof HTMLInputElement && ["Home","End"].includes(event.key)) return;
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close(true); return; }
      if (event.key === "Tab") { close(); return; }
      event.preventDefault();
      const buttons = [...(menu.current?.querySelectorAll("button") ?? [])];
      if (!buttons.length) return;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (current < 0 ? event.key === "ArrowDown" ? 0 : buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length);
      buttons[index]?.focus({ preventScroll: true });
    }}>
    <div className="wf-menu-title" aria-hidden="true">{title}</div>
    {searchable && <input className="wf-menu-search" aria-label="搜索节点类型" placeholder="搜索节点类型" value={query} onChange={event => setQuery(event.target.value)}/>}
    {filtered.map(({ label, icon: Icon, action, shortcut, secondary, dangerous }) => <button type="button" role="menuitem" key={label}
      data-separator={secondary || undefined} data-dangerous={dangerous || undefined} onClick={action}>
      <Icon size={14}/><span>{label}</span>{shortcut && <kbd>{shortcut}</kbd>}
    </button>)}
    {!filtered.length && <small className="wf-menu-title">没有匹配的节点类型</small>}
  </div>;
}
