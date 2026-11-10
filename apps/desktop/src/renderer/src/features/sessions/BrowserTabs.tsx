import type { RefObject } from "react";
import { Globe, LoaderCircle, Plus, X } from "lucide-react";
import type { BrowserTab } from "../../types/bridge";

export function BrowserTabs({ tabs, selectedId, strip, zh, onAction }: {
  tabs: BrowserTab[];
  selectedId?: string;
  strip: RefObject<HTMLDivElement>;
  zh: boolean;
  onAction: (action:"select"|"close"|"new", value?:unknown) => void;
}) {
  return <div className="browser-tabs">
    <div ref={strip} className="browser-tab-strip no-drag" role="tablist" aria-label={zh ? "此窗口的标签页" : "Tabs in this window"}>
      {tabs.map(tab => {
        const title = tab.title || (tab.url && tab.url !== "about:blank" ? tab.url : zh ? "新标签页" : "New tab");
        return <div key={tab.id} className="browser-tab" data-selected={selectedId === tab.id} data-busy={tab.busy}>
          <button type="button" role="tab" aria-selected={selectedId === tab.id} title={tab.url || title} onClick={() => onAction("select", {tabId:tab.id})}>
            {tab.busy ? <LoaderCircle size={14} className="browser-tab-loading tab-icon" aria-hidden/> : tab.favicon ? <img className="tab-icon" src={tab.favicon} width={16} height={16} alt=""/> : <Globe size={14} className="tab-icon" aria-hidden/>}
            <span className="truncate">{title}</span>
          </button>
          <button type="button" className="workspace-panel-icon browser-tab-close" title={zh ? "关闭标签页" : "Close tab"} aria-label={(zh ? "关闭标签页 " : "Close tab ") + title} onClick={() => onAction("close", {tabId:tab.id})}><X size={12}/></button>
        </div>;
      })}
    </div>
    <button type="button" className="workspace-panel-icon browser-new-tab no-drag" title={zh ? "新建标签页" : "New tab"} aria-label={zh ? "新建标签页" : "New tab"} onClick={() => onAction("new")}><Plus size={17}/></button>
  </div>;
}
