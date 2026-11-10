import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Globe,
  Hand,
  Play,
  Plus,
  X,
  Trash2,
  ZoomIn,
  ZoomOut,
  LayoutGrid,
  MousePointer2,
  House,
  LockKeyhole,
  MoreHorizontal,
} from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import type { BrowserPanelState, BrowserTab } from "../../types/bridge";
import { WorkspaceDrawer } from "./WorkspaceDrawer";
import { BrowserTabs } from "./BrowserTabs";

function tabTitle(tab: BrowserTab, blank: string) {
  if (!tab.url || tab.url === "about:blank") return blank;
  return tab.title || tab.url;
}

export function BrowserDrawer({
  sessionId,
  onClose,
  onOverview,
  surfaceSuspended = false,
}: {
  sessionId: string;
  onClose: () => void;
  onOverview?: (keyboard?:boolean) => void;
  surfaceSuspended?: boolean;
}) {
  const { locale } = useI18n(),
    zh = locale === "zh-CN";
  const app = getBridge()!;
  const bridge = app.browser!;
  const windowChrome = app.panels?.context?.kind === "browser" || app.panels?.context?.kind === "browser-spaces";
  const viewport = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState("");
  const [overview, setOverview] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [state, setState] = useState<BrowserPanelState>({
    manual: false,
    title: "",
    url: "",
    busy: false,
  });
  const addressInput = useRef<HTMLInputElement>(null);
  const visibleTab = useRef<string>();
  const tabStrip = useRef<HTMLDivElement>(null);
  const livePage =
    state.tabs !== undefined
      ? Boolean(state.url && state.url !== "about:blank")
      : state.manual;
  useEffect(() => {
    const selected = tabStrip.current?.querySelector<HTMLElement>(
      '[aria-selected="true"]',
    );
    selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.tabId]);
  const [error, setError] = useState("");
  const editing = useRef(false);
  const generation = useRef(0);
  const report = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));

  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const version = generation.current;
      try {
        const next = await bridge.panel(sessionId, "state");
        if (!disposed && version === generation.current && next) {
          setState(next);
          if (visibleTab.current !== next.tabId || !editing.current)
            setAddress(next.url === "about:blank" ? "" : next.url);
          visibleTab.current = next.tabId;
        }
      } catch (e) {
        if (!disposed) report(e);
      }
      if (!disposed) timer = setTimeout(() => void refresh(), 900);
    }
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      void bridge.panel(sessionId, "hide").catch(() => {});
    };
  }, [bridge, sessionId]);

  useEffect(() => {
    const element = viewport.current;
    if (!livePage || !element || overview || surfaceSuspended) return;
    const update = () => {
      const r = element.getBoundingClientRect();
      const obscured =
        document.hidden ||
        !r.width ||
        !r.height ||
        !!document.querySelector(
          '[aria-modal="true"],[data-radix-popper-content-wrapper],[role="alertdialog"]',
        );
      void bridge
        .panel(sessionId, obscured ? "hide" : "layout", {
          tabId: state.tabId,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        })
        .catch(report);
    };
    const resize = new ResizeObserver(update);
    resize.observe(element);
    const overlays = new MutationObserver(update);
    overlays.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("visibilitychange", update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    update();
    return () => {
      resize.disconnect();
      overlays.disconnect();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      void bridge
        .panel(sessionId, "hide", { tabId: state.tabId })
        .catch(() => {});
    };
  }, [livePage, overview, state.tabId, sessionId, bridge, surfaceSuspended]);

  async function command(
    action:
      | "control"
      | "open"
      | "home"
      | "new"
      | "select"
      | "close"
      | "back"
      | "forward"
      | "reload"
      | "zoom",
    value?: unknown,
  ) {
    setOverview(false);
    const version = ++generation.current;
    setError("");
    try {
      const next = await bridge.panel(sessionId, action, value);
      if (version === generation.current && next) {
        setState(next);
        if (!editing.current || visibleTab.current !== next.tabId)
          setAddress(next.url === "about:blank" ? "" : next.url);
        visibleTab.current = next.tabId;
        if (action === "new" || action === "home") requestAnimationFrame(() => addressInput.current?.focus());
      }
    } catch (e) {
      report(e);
    }
  }
  useEffect(() => {
    if (state.tabId && state.url === "about:blank") addressInput.current?.focus();
  }, [state.tabId]);
  const tabOverview = () => {
    if (overview) { setOverview(false); return; }
    setOverview(true);
    void bridge.panel(sessionId, "overview").then(next => { if (next?.thumbnails) setThumbnails(next.thumbnails); }).catch(report);
  };
  const more = async () => {
    const action = await app.menu.popup([
      {id:"zoom-out",label:zh ? "缩小" : "Zoom out",enabled:(state.zoomFactor ?? 1) > .25},
      {id:"zoom-reset",label:zh ? `缩放 ${Math.round((state.zoomFactor ?? 1)*100)}% · 恢复 100%` : `Zoom ${Math.round((state.zoomFactor ?? 1)*100)}% · Reset to 100%`},
      {id:"zoom-in",label:zh ? "放大" : "Zoom in",enabled:(state.zoomFactor ?? 1) < 3},
      {id:"separator",label:"",type:"separator"},
      {id:"tabs",label:zh ? "此窗口的标签页总览" : "Tabs in this window"},
      ...(state.workspaceSource !== "window" ? [{id:"dock",label:zh ? "放回工作台" : "Dock in workbench"}] : []),
    ]);
    if (action === "tabs") tabOverview();
    if (action === "zoom-reset") await command("zoom",{tabId:state.tabId,factor:1});
    if (action === "zoom-in" || action === "zoom-out") await command("zoom",{tabId:state.tabId,factor:Math.min(3,Math.max(.25,Math.round(((state.zoomFactor ?? 1)+(action === "zoom-in" ? .25 : -.25))*100)/100))});
    if (action === "dock") { await bridge.panel(sessionId,"hide"); await app.panels?.dock(); }
  };
  const controlsLabel = state.manual
      ? zh
        ? "交还 AI"
        : "Return to AI"
      : zh
        ? "接管"
        : "Take control";
  const title = state.workspaceName || (zh ? "浏览器" : "Browser");
  return (
    <WorkspaceDrawer
      open
      onClose={onClose}
      title={title}
      className={`browser-workspace${windowChrome ? " browser-window-native" : ""}`}
      windowChrome={windowChrome}
      nativePanel={{ kind: "browser", sessionId }}
      defaultWidth={760}
      defaultMaximized
      minWidth={360}
      adjacentMinWidth={384}
      resizable
      storageKey="nautilo.browser.width"
      headerContent={windowChrome ? <BrowserTabs tabs={state.tabs ?? []} selectedId={state.tabId} strip={tabStrip} zh={zh} onAction={(action,value) => void command(action,value)}/> :
        <span className="flex items-center gap-2 text-sm font-medium">
          <Globe size={16} />
          {title}
        </span>
      }
      headerActions={
        <>
          {windowChrome && <button type="button" className="browser-windows-button" title={zh ? "窗口总览" : "All windows"} aria-label={zh ? "窗口总览" : "All windows"} onClick={event => onOverview ? onOverview(event.detail === 0) : void app.panels?.open({kind:"browser-spaces"}).catch(report)}><LayoutGrid size={17}/></button>}
          {!windowChrome && state.tabs && <button type="button" className={`workspace-panel-icon${overview ? " is-active" : ""}`}
            title={zh ? "网页总览" : "Tab overview"} aria-label={zh ? "网页总览" : "Tab overview"} aria-pressed={overview}
            onClick={tabOverview}><LayoutGrid size={16}/></button>}
          {!windowChrome && state.zoomFactor !== undefined && (
            <div className="browser-zoom">
              <button
                type="button"
                className="workspace-panel-icon"
                aria-label={zh ? "缩小网页" : "Zoom out"}
                title={zh ? "缩小网页" : "Zoom out"}
                disabled={state.zoomFactor <= 0.25}
                onClick={() =>
                  void command("zoom", {
                    tabId: state.tabId,
                    factor: Math.max(
                      0.25,
                      Math.round((state.zoomFactor! - 0.25) * 100) / 100,
                    ),
                  })
                }
              >
                <ZoomOut size={14} />
              </button>
              <button
                type="button"
                className="browser-zoom-reset"
                aria-label={zh ? "恢复网页缩放" : "Reset zoom"}
                title={zh ? "恢复到 100%" : "Reset to 100%"}
                onClick={() =>
                  void command("zoom", { tabId: state.tabId, factor: 1 })
                }
              >
                {Math.round(state.zoomFactor * 100)}%
              </button>
              <button
                type="button"
                className="workspace-panel-icon"
                aria-label={zh ? "放大网页" : "Zoom in"}
                title={zh ? "放大网页" : "Zoom in"}
                disabled={state.zoomFactor >= 3}
                onClick={() =>
                  void command("zoom", {
                    tabId: state.tabId,
                    factor: Math.min(
                      3,
                      Math.round((state.zoomFactor! + 0.25) * 100) / 100,
                    ),
                  })
                }
              >
                <ZoomIn size={14} />
              </button>
            </div>
          )}
          {!windowChrome && !state.tabs && (
            <button
              type="button"
              className="workspace-panel-icon"
              title={zh ? "关闭此网页" : "Close this page"}
              aria-label={zh ? "关闭此网页" : "Close this page"}
              onClick={() => {
                onClose();
                void bridge.panel(sessionId, "release").catch(report);
              }}
            >
              <Trash2 size={15} />
            </button>
          )}
        </>
      }
    >
      {!windowChrome && state.tabs && !overview && <BrowserTabs tabs={state.tabs} selectedId={state.tabId} strip={tabStrip} zh={zh} onAction={(action,value) => void command(action,value)}/>}
      {!overview && <div className="browser-navigation">
        {state.tabs && (
          <div className="browser-history">
            {(
              [
                ["back", zh ? "后退" : "Back", ArrowLeft, state.canGoBack],
                [
                  "forward",
                  zh ? "前进" : "Forward",
                  ArrowRight,
                  state.canGoForward,
                ],
                [
                  "reload",
                  zh ? "刷新网页" : "Reload page",
                  RotateCw,
                  !!state.url,
                ],
              ] as const
            ).map(([action, label, Icon, enabled]) => (
              <button
                key={action}
                type="button"
                className="workspace-panel-icon"
                aria-label={label}
                title={label}
                disabled={!enabled}
                onClick={() => void command(action, { tabId: state.tabId })}
              >
                <Icon size={14} />
              </button>
            ))}
          </div>
        )}
        {windowChrome && <button type="button" className="workspace-panel-icon" title={zh ? "主页" : "Home"} aria-label={zh ? "主页" : "Home"} onClick={() => void command("home",{tabId:state.tabId})}><House size={17}/></button>}
        <form
          className="browser-address"
          onSubmit={(event) => {
            event.preventDefault();
            if (address.trim()) {
              const value = address.trim();
              const url = /^[a-z][\w+.-]*:\/\//i.test(value) ? value : /^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(value) ? "http://"+value : /^[^\s/]+\.[^\s]+/.test(value) ? "https://"+value : "https://www.baidu.com/s?wd="+encodeURIComponent(value);
              addressInput.current?.blur();
              void command(
                "open",
                state.tabs ? { tabId: state.tabId, url } : url,
              );
            }
          }}
        >
          {windowChrome && <span className="browser-site-icon" title={state.url.startsWith("https:") ? "HTTPS" : undefined}>{state.url.startsWith("https:") ? <LockKeyhole size={14}/> : <Globe size={14}/>}</span>}
          <input
            ref={addressInput}
            className="min-w-0 flex-1 bg-transparent p-1 text-xs outline-none"
            aria-label={zh ? "网址" : "URL"}
            placeholder={zh ? "搜索或输入网址" : "Search or enter address"}
            value={address}
            onFocus={() => {
              editing.current = true;
            }}
            onBlur={() => {
              editing.current = false;
            }}
            onChange={(e) => setAddress(e.target.value)}
          />
          <button
            type="submit"
            className="workspace-panel-icon"
            title={zh ? "打开网址" : "Open URL"}
            aria-label={zh ? "打开网址" : "Open URL"}
          >
            <ArrowRight size={14} />
          </button>
        </form>
        <button
          type="button"
          className="browser-control-button flex items-center gap-1.5 rounded-lg border border-line px-2 py-1.5 text-xs"
          data-manual={state.manual}
          aria-label={controlsLabel}
          title={
            state.tabs
              ? zh
                ? "你始终可以操作网页。可在这里暂停或恢复 AI 对此页的操作，AI 仍可读取。"
                : "Pause or resume AI actions on this tab. You can always interact, and AI can still read."
              : undefined
          }
          onClick={() =>
            void command(
              "control",
              state.tabs
                ? { tabId: state.tabId, manual: !state.manual }
                : !state.manual,
            )
          }
        >
          {state.manual ? <Play size={13} /> : <Hand size={13} />}
          <span className="browser-control-label">{controlsLabel}</span>
        </button>
        {windowChrome && <button type="button" className="workspace-panel-icon browser-more" aria-label={zh ? "浏览器菜单" : "Browser menu"} title={zh ? "浏览器菜单" : "Browser menu"} onClick={() => void more().catch(report)}><MoreHorizontal size={19}/></button>}
      </div>}
      {error && (
        <div role="alert" className="px-3 py-1 text-xs text-danger">
          {error}
        </div>
      )}
      <div
        ref={viewport}
        data-browser-viewport=""
        className={`relative min-h-0 flex-1 overflow-hidden bg-surface${overview ? " browser-overview" : ""}`}
      >
        {overview ? <>
          <div className="browser-overview-heading"><h3>{zh ? "网页总览" : "Tabs"}<span>{state.tabs?.length ?? 0}</span></h3>
            <button className="workspace-panel-icon" aria-label={zh ? "返回网页" : "Back to page"} onClick={() => setOverview(false)}><X size={18}/></button>
          </div>
          <div className="browser-space-grid">
            {state.tabs?.map(tab => <button key={tab.id} className="browser-space" data-active={tab.ownership === "agent"} onClick={() => void command("select", {tabId: tab.id})}>
              <div className="browser-space-preview">
                {thumbnails[tab.id] ? <img src={thumbnails[tab.id]} alt=""/> : <div className="browser-space-placeholder"><Globe size={34}/><span>{tab.url !== "about:blank" ? tab.url : (zh ? "新标签页" : "New tab")}</span></div>}
                {tab.ownership === "agent" && <span className="browser-space-running"><MousePointer2 size={12}/>{zh ? "AI 控制中" : "Agent in control"}</span>}
              </div>
              <div className="browser-space-caption"><span>{tabTitle(tab, zh ? "新标签页" : "New tab")}</span><span>{tab.manual ? (zh ? "你正在控制" : "Your control") : tab.label}</span></div>
            </button>)}
            <button className="browser-space browser-space-new" onClick={() => void command("new")} aria-label={zh ? "新建标签页" : "New tab"}><Plus size={36}/></button>
          </div>
        </> : !livePage &&
          (state.image ? (
            <img
              src={state.image}
              alt={zh ? "会话网页实时预览" : "Conversation page preview"}
              className="absolute inset-0 h-full w-full object-contain object-top"
            />
          ) : (
            <div className="grid h-full place-items-center px-6 text-center text-sm text-ink-3">
              {state.url && state.url !== "about:blank"
                ? zh
                  ? "正在加载网页…"
                  : "Loading page…"
                : zh
                  ? "输入网址，或让 AI 打开网页"
                  : "Enter a URL or ask the agent to open a page"}
            </div>
          ))}
      </div>
    </WorkspaceDrawer>
  );
}
