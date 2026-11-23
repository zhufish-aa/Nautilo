import { useLayoutEffect, useRef, type RefObject } from "react";
import { Globe, LoaderCircle, Plus, X } from "lucide-react";
import type { BrowserTab } from "../../types/bridge";
import type { BrowserTabSignals } from "../../../../shared/browser-shell";

export function BrowserTabs({ tabs, selectedId, strip, zh, signals, onAction }: {
  tabs: BrowserTab[];
  selectedId?: string;
  strip: RefObject<HTMLDivElement>;
  zh: boolean;
  signals: Record<string,BrowserTabSignals>;
  onAction: (action:"select"|"close"|"new", value?:unknown) => void;
}) {
  const line = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const viewport = strip.current, indicator = line.current;
    if (!viewport || !indicator) return;
    const tab = viewport.querySelector<HTMLElement>(".browser-tab[data-selected=true]");
    if (!tab) {indicator.style.opacity="0";return;}
    const update = () => {
      indicator.style.transform = `translateX(${tab.offsetLeft}px) scaleX(${tab.offsetWidth})`;
      indicator.style.opacity = "1";
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    for (const child of viewport.querySelectorAll(".browser-tab")) observer.observe(child);
    tab.scrollIntoView({block:"nearest",inline:"nearest"});
    return () => observer.disconnect();
  }, [selectedId,tabs.length,strip]);
  return <div className="browser-tabs">
    <div ref={strip} className="browser-tab-strip no-drag" role="tablist" aria-label={zh ? "此窗口的标签页" : "Tabs in this window"}
      onWheel={event => {if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;}}>
      {tabs.map(tab => {
        const title = !tab.url || tab.url === "about:blank" ? (zh ? "新标签页" : "New tab") : tab.title || tab.url;
        const current = signals[tab.id];
        return <div key={tab.id} className="browser-tab" data-selected={selectedId === tab.id} onAuxClick={event => {
          if (event.button === 1) onAction("close",{tabId:tab.id});
        }}>
          <button type="button" role="tab" aria-selected={selectedId === tab.id} title={title} onClick={() => onAction("select", {tabId:tab.id})}>
            {current?.loading ? <LoaderCircle className="browser-tab-loading tab-icon" aria-hidden/> : tab.favicon && tab.url !== "about:blank" ? <img className="tab-icon" src={tab.favicon} alt=""/> : <Globe className="tab-icon" aria-hidden/>}
            <span className="truncate">{title}</span>
            {!!current?.unread && <span className="br-dot" data-tone="danger" aria-label={zh ? "有未读诊断" : "Unread diagnostics"}/>}
          </button>
          <button type="button" className="br-icon browser-tab-close" title={zh ? "关闭标签页" : "Close tab"} aria-label={(zh ? "关闭标签页 " : "Close tab ") + title} onClick={() => onAction("close", {tabId:tab.id})}><X/></button>
        </div>;
      })}
      <span ref={line} className="br-tab-indicator" aria-hidden/>
    </div>
    <button type="button" className="br-icon no-drag" title={zh ? "新建标签页" : "New tab"} aria-label={zh ? "新建标签页" : "New tab"} onClick={() => onAction("new")}><Plus/></button>
  </div>;
}
