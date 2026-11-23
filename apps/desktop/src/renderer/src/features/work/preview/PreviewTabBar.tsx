import { useEffect, useLayoutEffect, useRef } from "react";
import { Braces, FileCode2, FileImage, FileText, X } from "lucide-react";
import { useI18n } from "../../../lib/i18n";

export function PreviewTabBar({ tabs, active, resolvePath, onSelect, onCloseTabs, pathControl }: {
  tabs: string[];
  active?: string;
  resolvePath(path: string): string;
  onSelect(path: string): void;
  onCloseTabs(paths: string[]): void;
  pathControl?: React.ReactNode;
}): JSX.Element {
  const { locale } = useI18n();
  const fullPath = active && resolvePath(active);
  const zh = locale === "zh-CN";
  const rail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = rail.current;
    if (!node) return;
    const wheel = (event: WheelEvent): void => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || node.scrollWidth <= node.clientWidth) return;
      event.preventDefault();
      node.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [tabs.length > 1]);

  useLayoutEffect(() => {
    rail.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  const names = tabs.map(path => path.split("/").at(-1) || path);
  const icon = (path: string): JSX.Element => {
    const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
    const Icon = /^(png|jpe?g|gif|webp|svg)$/.test(extension) ? FileImage
      : /^(json|tsx?|jsx?)$/.test(extension) ? Braces
      : /^(rs|py|go|c|cpp|cs|sh|css|html)$/.test(extension) ? FileCode2 : FileText;
    return <Icon size={15} aria-hidden />;
  };

  if (tabs.length <= 1) return <div className="preview-file-title">
    {active ? <><span className="preview-filename" title={fullPath}>{icon(active)}<strong>{names[0]}</strong></span>
      {pathControl}</> : <span>{zh ? "文件预览" : "File preview"}</span>}
  </div>;

  return <div className="preview-file-title">
    <div ref={rail} className="preview-tab-scroll" role="tablist" aria-label={zh ? "文件标签" : "File tabs"}
      onKeyDown={(event) => {
        const current = tabs.indexOf(active ?? "");
        if (event.key === "Delete" && active) { event.preventDefault(); onCloseTabs([active]); return; }
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
          : event.key === "ArrowRight" ? (current + 1) % tabs.length
          : event.key === "ArrowLeft" ? (current + tabs.length - 1) % tabs.length : -1;
        if (next < 0) return;
        event.preventDefault();
        onSelect(tabs[next]!);
        rail.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>
      {tabs.map((path, index) => <div className="preview-tab" data-selected={path === active} key={path}
        onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onCloseTabs([path]); } }}
        onPointerDown={(event) => { if (event.button === 1) event.preventDefault(); }}
        onContextMenu={async (event) => {
          if (!window.agenthub?.menu) return;
          event.preventDefault();
          const choice = await window.agenthub.menu.popup([
            { id: "others", label: zh ? "关闭其他" : "Close others" },
            { id: "right", label: zh ? "关闭右侧" : "Close to the right", enabled: index < tabs.length - 1 },
            { id: "copy", label: zh ? "复制路径" : "Copy path" }
          ]);
          if (choice === "others") onCloseTabs(tabs.filter(other => other !== path));
          if (choice === "right") onCloseTabs(tabs.slice(index + 1));
          if (choice === "copy") await navigator.clipboard.writeText(resolvePath(path));
        }}>
        <button role="tab" type="button" className="preview-tab-label" aria-selected={path === active}
          tabIndex={path === active ? 0 : -1} title={path} onClick={() => onSelect(path)}>
          {icon(path)}<span>{names[index]}{names.filter(name => name === names[index]).length > 1 && <small> · {path.split("/").slice(0, -1).join("/")}</small>}</span>
        </button>
        <button type="button" className="preview-tab-close" aria-label={zh ? `关闭 ${names[index]}` : `Close ${names[index]}`}
          onClick={() => onCloseTabs([path])}><X size={12} aria-hidden /></button>
      </div>)}
    </div>
    {pathControl}
  </div>;
}
