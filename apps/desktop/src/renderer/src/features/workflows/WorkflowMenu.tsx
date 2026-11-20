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

export function WorkflowMenu({ title, anchor, actions, close }: {
  title: string; anchor: Point; actions: MenuAction[]; close(restore?: boolean): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(anchor);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element?.parentElement) return;
    const { clientWidth, clientHeight } = element.parentElement;
    setPosition({
      x: Math.max(8, Math.min(anchor.x, clientWidth - element.offsetWidth - 8)),
      y: Math.max(8, Math.min(anchor.y, clientHeight - element.offsetHeight - 8)),
    });
    element.querySelector("button")?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent): void => {
      if (!element.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [anchor.x, anchor.y, title, close]);
  return <div ref={menu} className="wf-context-menu" role="menu" aria-label={title} style={{ left: position.x, top: position.y }}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      if (!["ArrowUp", "ArrowDown", "Home", "End", "Escape", "Tab"].includes(event.key)) return;
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close(true); return; }
      if (event.key === "Tab") { close(); return; }
      event.preventDefault();
      const buttons = [...(menu.current?.querySelectorAll("button") ?? [])];
      if (!buttons.length) return;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (Math.max(0, current) + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index]?.focus({ preventScroll: true });
    }}>
    <div className="wf-menu-title" aria-hidden="true">{title}</div>
    {actions.map(({ label, icon: Icon, action, shortcut, secondary, dangerous }) => <button type="button" role="menuitem" key={label}
      data-separator={secondary || undefined} data-dangerous={dangerous || undefined} onClick={action}>
      <Icon size={14}/><span>{label}</span>{shortcut && <kbd>{shortcut}</kbd>}
    </button>)}
  </div>;
}
