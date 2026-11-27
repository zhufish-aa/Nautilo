import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowLeft, ArrowRight, Bug, Camera, Check, Code2, Copy, Crop, Crosshair, Globe, Hand, LayoutGrid,
  LockKeyhole, MonitorSmartphone, MoreHorizontal, Pin, Play, RotateCw, X,
} from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { toast } from "../../stores/toast";
import type { BrowserPanelState } from "../../types/bridge";
import type { BrowserOmniboxData, BrowserShellState } from "../../../../shared/browser-shell";
import { WorkspaceDrawer } from "./WorkspaceDrawer";
import { BrowserTabs } from "./BrowserTabs";
import { BrowserDiagnostics } from "./BrowserDiagnostics";
import { BrowserStart } from "./BrowserStart";

const emptyState:BrowserPanelState = {manual:false,title:"",url:"",busy:false};
const emptySignals:BrowserShellState = {tabs:{},issues:[],pinned:false};
const emptyOmnibox:BrowserOmniboxData = {ports:[],tabs:[],history:[]};
const devices = [
  {id:"desktop",label:"桌面",en:"Desktop",width:1440,height:900},
  {id:"tablet",label:"平板",en:"Tablet",width:768,height:1024},
  {id:"phone",label:"手机",en:"Phone",width:390,height:844},
] as const;

const isPage = (url:string) => !!url && url !== "about:blank";
function addressUrl(text:string) {
  const value = text.trim();
  if (/^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) <= 65535) return "http://localhost:" + value;
  if (/^[a-z][\w+.-]*:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(value)) return "http://" + value;
  if (/^[^\s/]+\.[^\s]+/.test(value)) return "https://" + value;
  return "https://www.baidu.com/s?wd=" + encodeURIComponent(value);
}

export function browserDomain(url:string) {
  try {return new URL(url).host;}
  catch {return "";}
}

type Navigation = "control"|"open"|"home"|"new"|"select"|"close"|"back"|"forward"|"reload"|"zoom";
type Suggestion = {key:string;title:string;url:string;kind:string;spaceId?:string;tabId?:string};

export function BrowserDrawer({sessionId,onClose,onOverview,surfaceSuspended=false}:{
  sessionId:string;
  onClose:()=>void;
  onOverview?:(keyboard?:boolean)=>void;
  surfaceSuspended?:boolean;
}) {
  const app = getBridge()!, bridge = app.browser!;
  const zh = useI18n().locale === "zh-CN";
  const word = (cn:string,en:string) => zh ? cn : en;
  const reducedMotion = useUiReducedMotion();
  const detached = !!app.panels?.context;
  const [state,setState] = useState(emptyState);
  const [signals,setSignals] = useState(emptySignals);
  const [omnibox,setOmnibox] = useState(emptyOmnibox);
  const [count,setCount] = useState(0);
  const [address,setAddress] = useState("");
  const [focused,setFocused] = useState(false);
  const [edited,setEdited] = useState(false);
  const [choice,setChoice] = useState(-1);
  const [cover,setCover] = useState<string|null>(null);
  const [feedback,setFeedback] = useState<"copy"|"capture">();
  const [picker,setPicker] = useState<"element"|"region">();
  const [diagnostics,setDiagnostics] = useState(false);
  const [notice,setNotice] = useState(true);
  const [device,setDevice] = useState<typeof devices[number]>();
  const [landscape,setLandscape] = useState(false);
  const [deviceMenu,setDeviceMenu] = useState(false);
  const [deviceCover,setDeviceCover] = useState("");
  const [deviceTransition,setDeviceTransition] = useState<{from:DOMRect;image:string}>();
  const [surfaceSize,setSurfaceSize] = useState({width:0,height:0});
  const [error,setError] = useState("");
  const generation = useRef(0), extrasRevision = useRef(0);
  const editing = useRef(false), opening = useRef(false);
  const addressInput = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const deviceArea = useRef<HTMLDivElement>(null);
  const deviceTools = useRef<HTMLDivElement>(null);
  const deviceShot = useRef<HTMLImageElement>(null);
  const deviceMenuRequest = useRef(0);
  const tabStrip = useRef<HTMLDivElement>(null);
  const visibleTab = useRef<string>();
  const tabId = state.tabId ?? "";
  const tab = {spaceId:sessionId,tabId};
  const page = isPage(state.url);
  const active = state.ownership === "agent";
  const current = signals.tabs[tabId];
  const zoom = Math.round((state.zoomFactor ?? 1)*100);
  const width = device ? landscape ? device.height : device.width : 0;
  const height = device ? landscape ? device.width : device.height : 0;
  const scale = device && surfaceSize.width && surfaceSize.height
    ? Math.min(1,Math.max(1,surfaceSize.width-20)/width,Math.max(1,surfaceSize.height-20)/height) : 1;
  const report = (err:unknown) => setError(err instanceof Error ? err.message : String(err));
  const sync = (next:BrowserPanelState) => {
    const changedTab = visibleTab.current !== next.tabId;
    if (changedTab || !editing.current) setAddress(isPage(next.url) ? next.url : "");
    if (changedTab) {
      deviceMenuRequest.current++;
      setDeviceMenu(false);
      setDeviceCover("");
      setDeviceTransition(undefined);
    }
    visibleTab.current = next.tabId;
    setState(next);
  };
  const hydrate = async (probe:boolean) => {
    try {setOmnibox(await bridge.shell("omnibox",{probe}));}
    catch (err) {report(err);}
  };
  useEffect(() => {
    let disposed = false, running = false;
    const refresh = async () => {
      if (disposed || running || document.hidden) return;
      running = true;
      const version = generation.current;
      try {
        const next = await bridge.panel(sessionId,"state");
        if (!disposed && version === generation.current && !opening.current && next) sync(next);
      } catch (err) {if (!disposed) report(err);}
      finally {running = false;}
    };
    const windows = () => void bridge.spaces("list").then(result => {if (!disposed) setCount(result.spaces.length);}).catch(report);
    const timer = setInterval(() => void refresh(),650);
    const windowsTimer = setInterval(windows,5000);
    void refresh();
    windows();
    void hydrate(false);
    return () => {
      disposed = true;
      clearInterval(timer);
      clearInterval(windowsTimer);
      void bridge.panel(sessionId,"hide").catch(() => {});
    };
  },[bridge,sessionId]);
  useEffect(() => {
    if (!page && tabId) void hydrate(true);
  },[page,tabId]);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const version = ++extrasRevision.current;
      try {
        const value = await bridge.shell("state",{spaceId:sessionId,tabId});
        if (!disposed && version === extrasRevision.current) setSignals(value);
      } catch (err) {if (!disposed) report(err);}
    };
    const remove = bridge.onShellChange(event => {
      if (event.spaceId !== sessionId) return;
      if (event.focusAddress) addressInput.current?.focus();
      void refresh();
    });
    void refresh();
    return () => {disposed=true;remove();};
  },[bridge,sessionId,tabId]);

  useLayoutEffect(() => {
    const element = deviceArea.current;
    if (!device || !element) return;
    const measure = () => {
      const width = element.clientWidth, height = element.clientHeight;
      setSurfaceSize(previous => previous.width === width && previous.height === height ? previous : {width,height});
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  },[device,page]);
  const suggestions:Suggestion[] = [];
  if (focused) {
    const value = edited ? address.toLowerCase().trim() : "";
    const matches = (text:string) => !value || value.split(/\s+/).every(word => text.toLowerCase().includes(word));
    for (const entry of omnibox.ports) {
      const title = "localhost:"+entry;
      if (matches(title)) suggestions.push({key:"port:"+entry,title,url:"http://"+title,kind:word("本机","Local")});
    }
    for (const entry of omnibox.tabs) {
      if (entry.tabId !== tabId && matches(entry.title+" "+entry.url))
        suggestions.push({key:"tab:"+entry.tabId,...entry,kind:word("切换标签","Switch tab")});
    }
    for (const entry of omnibox.history) {
      if (matches(entry.title+" "+entry.url))
        suggestions.push({key:"history:"+entry.url,...entry,kind:word("历史","History")});
    }
    suggestions.length = Math.min(suggestions.length,8);
  }
  const showSuggestions = suggestions.length > 0 && (!page || cover !== null);
  const covered = page && showSuggestions;
  useLayoutEffect(() => {
    if (!deviceTransition || !deviceShot.current || !viewport.current) return;
    const layer = deviceShot.current;
    const from = deviceTransition.from, to = viewport.current.getBoundingClientRect();
    if (!to.width || !to.height || reducedMotion) {setDeviceTransition(undefined);return;}
    Object.assign(layer.style,{left:to.x+"px",top:to.y+"px",width:to.width+"px",height:to.height+"px"});
    const moving = layer.animate([
      {transform:`translate(${from.x-to.x}px,${from.y-to.y}px) scale(${from.width/to.width},${from.height/to.height})`},
      {transform:"none"},
    ],{duration:260,easing:"cubic-bezier(.22,1,.36,1)",fill:"both"});
    let disposed = false;
    void moving.finished.then(async () => {
      if (disposed) return;
      await bridge.panel(sessionId,"layout",{tabId,x:to.x,y:to.y,width:to.width,height:to.height});
      if (!disposed && device) await bridge.shell("viewport",{...tab,device:{width,height,scale}});
    }).finally(() => {
      if (!disposed) setDeviceTransition(undefined);
    }).catch(error => {if (!disposed) report(error);});
    return () => {disposed=true;moving.cancel();};
  },[deviceTransition,scale,reducedMotion,bridge,sessionId,tabId]);
  useEffect(() => {
    const element = viewport.current;
    if (!page || !tabId || !element || surfaceSuspended || covered || deviceMenu || deviceTransition) return;
    let frame = 0;
    let disposed = false;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const obscured = document.hidden || !rect.width || !rect.height || !!document.querySelector('[aria-modal="true"],[data-radix-popper-content-wrapper],[role="alertdialog"]');
      void bridge.panel(sessionId,obscured ? "hide" : "layout",{
        tabId,x:rect.x,y:rect.y,width:rect.width,height:rect.height,
      }).then(async () => {
        if (!disposed && !obscured && device) await bridge.shell("viewport",{spaceId:sessionId,tabId,device:{width,height,scale}});
      }).catch(report);
    };
    let waiting = false;
    const queue = () => {
      if (waiting) return;
      waiting = true;
      frame = requestAnimationFrame(() => {waiting=false;update();});
    };
    const resize = new ResizeObserver(queue);
    const overlays = new MutationObserver(queue);
    resize.observe(element);
    overlays.observe(document.body,{childList:true,subtree:true});
    document.addEventListener("visibilitychange",queue);
    window.addEventListener("scroll",queue,true);
    window.addEventListener("resize",queue);
    update();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      overlays.disconnect();
      document.removeEventListener("visibilitychange",queue);
      window.removeEventListener("scroll",queue,true);
      window.removeEventListener("resize",queue);
      void bridge.panel(sessionId,"hide",{tabId}).catch(() => {});
    };
  },[bridge,sessionId,tabId,page,surfaceSuspended,covered,deviceMenu,deviceTransition,device,width,height,scale]);

  const run = async (action:Navigation,value?:unknown) => {
    const version = ++generation.current;
    opening.current = true;
    setError("");
    try {
      const result = await bridge.panel(sessionId,action,value);
      if (result && version === generation.current) sync(result);
    } catch (err) {if (version === generation.current) report(err);}
    finally {if (version === generation.current) opening.current = false;}
  };
  const closeAddress = () => {
    editing.current = false;
    setFocused(false);
    setEdited(false);
    setChoice(-1);
    setCover(null);
    setAddress(isPage(state.url) ? state.url : "");
  };
  const navigate = (value:string) => {
    addressInput.current?.blur();
    closeAddress();
    void run("open",{tabId,url:addressUrl(value)});
  };
  const startPicker = async (mode:"element"|"region") => {
    try {
      if (picker === mode) {await bridge.shell("cancel",tab);return;}
      if (picker) {await bridge.shell("cancel",tab);}
      setPicker(mode);
      if (await bridge.shell("pick",{...tab,mode})) {
        setFeedback("capture");
        toast.success(mode === "element"
          ? word("元素已作为上下文卡片加入输入框","Element added to composer")
          : word("区域截图已加入输入框","Region screenshot added to composer"));
      }
    } catch (err) {report(err);}
    finally {setPicker(undefined);}
  };
  const capture = async () => {
    try {
      if (await bridge.shell("capture",tab)) {
        setFeedback("capture");
        toast.success(word("截图已加入会话输入框","Screenshot added to chat draft"));
      }
    } catch (err) {report(err);}
  };
  useEffect(() => {
    if (!feedback) return;
    const timeout = setTimeout(() => setFeedback(undefined),1100);
    return () => clearTimeout(timeout);
  },[feedback]);
  const copy = () => void navigator.clipboard.writeText(state.url).then(() => setFeedback("copy")).catch(report);
  const select = async (suggestion:Suggestion) => {
    if (!suggestion.spaceId) {navigate(suggestion.url);return;}
    addressInput.current?.blur();
    closeAddress();
    try {
      if (suggestion.spaceId !== sessionId) {
        await app.panels!.open({kind:"browser",sessionId:suggestion.spaceId});
        await bridge.panel(suggestion.spaceId,"select",{tabId:suggestion.tabId});
      } else await run("select",{tabId:suggestion.tabId});
    } catch (err) {report(err);}
  };
  const addressKeys = (event:KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {event.stopPropagation();event.currentTarget.blur();return;}
    if (!suggestions.length || !["ArrowDown","ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    setChoice(index => (index + (event.key === "ArrowDown" ? 1 : index < 0 ? suggestions.length : -1) + suggestions.length) % suggestions.length);
  };
  useEffect(() => {
    const shortcut = (event:globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        addressInput.current?.focus();
      }
      if (event.key === "Escape" && picker) {
        event.stopPropagation();
        void bridge.shell("cancel",tab).catch(report);
      }
    };
    window.addEventListener("keydown",shortcut,true);
    return () => window.removeEventListener("keydown",shortcut,true);
  },[sessionId,tabId,picker,bridge]);
  const dismissDeviceMenu = () => {
    deviceMenuRequest.current++;
    setDeviceMenu(false);
    setDeviceCover("");
  };
  const changeDevice = async () => {
    const request = ++deviceMenuRequest.current;
    if (deviceMenu) {dismissDeviceMenu();return;}
    const image = page ? await bridge.panel(sessionId,"preview").then(result=>result?.image).catch(()=>undefined) : undefined;
    if (request !== deviceMenuRequest.current || !deviceTools.current) return;
    setDeviceCover(image ?? "");
    setDeviceMenu(true);
  };
  useEffect(() => {
    if (!deviceMenu) return;
    deviceTools.current?.querySelector<HTMLElement>("[role=menu] button")?.focus();
    const dismiss = (event:PointerEvent) => {
      if (!deviceTools.current?.contains(event.target as Node)) dismissDeviceMenu();
    };
    document.addEventListener("pointerdown",dismiss);
    return () => document.removeEventListener("pointerdown",dismiss);
  },[deviceMenu]);
  const selectDevice = async (next:typeof devices[number]|undefined, rotated=false) => {
    const from = viewport.current?.getBoundingClientRect();
    if (!reducedMotion && from?.width && from.height && (next !== device || rotated !== landscape)) {
      const image = deviceCover || await bridge.panel(sessionId,"preview").then(result=>result?.image).catch(()=>undefined);
      if (image) setDeviceTransition({from,image});
    }
    setDevice(next);
    setLandscape(rotated);
    dismissDeviceMenu();
  };
  const more = async () => {
    const action = await app.menu.popup([
      {id:"devtools",label:word("打开或关闭开发者工具","Toggle developer tools"),enabled:page},
      {id:"hard",label:word("清缓存强刷","Hard reload"),enabled:page},
      {id:"system",label:word("用默认浏览器打开","Open in default browser"),enabled:/^https?:/.test(state.url)},
      {id:"region",label:word("区域截屏入聊","Capture region to chat"),enabled:page},
      {id:"home",label:word("返回起始页","Return to start page"),enabled:!!tabId},
      {id:"separator",label:"",type:"separator"},
      {id:"out",label:word("缩小","Zoom out"),enabled:zoom>25},
      {id:"reset",label:word("恢复 100%","Reset to 100%")},
      {id:"in",label:word("放大","Zoom in"),enabled:zoom<300},
      ...(detached && state.workspaceSource !== "window" ? [{id:"dock",label:word("放回工作台","Dock in workbench")}] : []),
    ]);
    if (action === "hard") await bridge.shell("reload",{...tab,mode:"hard"});
    if (action === "devtools") await bridge.shell("devtools",tab);
    if (action === "system") await app.shell.openExternal(state.url);
    if (action === "region") await startPicker("region");
    if (action === "home") await run("home",{tabId});
    if (action === "dock") {await bridge.panel(sessionId,"hide");await app.panels?.dock();}
    if (action === "in" || action === "out" || action === "reset")
      await run("zoom",{tabId,factor:action==="reset" ? 1 : Math.min(3,Math.max(.25,(zoom+(action==="in"?25:-25))/100))});
  };
  const title = state.workspaceName || word("浏览器","Browser");
  const domain = browserDomain(state.url);
  const parsed = domain ? new URL(state.url) : undefined;
  const control = state.manual ? word("接管中 · 交还 AI","Manual · Return to AI")
    : active ? word("AI 操控中","AI in control") : word("接管","Take control");
  const takeControl = () => {setNotice(true);void run("control",{tabId,manual:!state.manual});};
  const showOverview = (keyboard:boolean) => {
    if (onOverview) onOverview(keyboard);
    else void app.panels?.open({kind:"browser-spaces"}).catch(report);
  };
  const viewportContents = <div key={device ? "device" : "page"} ref={viewport} className="br-viewport" data-browser-viewport="" style={device ? {width:Math.round(width*scale),height:Math.round(height*scale)} : undefined}>
    {covered && cover && <img src={cover} alt="" className="br-preview-cover"/>}
    {deviceMenu && deviceCover && <img src={deviceCover} alt="" className="br-preview-cover"/>}
  </div>;
  return <WorkspaceDrawer open onClose={onClose} title={title} className={`browser-workspace${detached ? " browser-window-native" : ""}`} windowChrome={detached}
    nativePanel={{kind:"browser",sessionId}} defaultWidth={760} defaultMaximized minWidth={360} adjacentMinWidth={384} resizable storageKey="nautilo.browser.width"
    headerContent={<>
      {!detached && <span className="br-session-mark" title={title} aria-label={title}><span className="br-dot" data-tone={active ? "blue" : "green"}/></span>}
      <BrowserTabs tabs={state.tabs ?? []} selectedId={tabId} strip={tabStrip} zh={zh} signals={signals.tabs} onAction={(action,value) => {
        setDiagnostics(false);
        void run(action,value);
      }}/>
    </>}
    headerActions={<>
      <button className="br-icon br-window-count" title={word("浏览器窗口总览","Browser windows")} aria-label={word("浏览器窗口总览","Browser windows")} onClick={event => showOverview(event.detail===0)}><LayoutGrid/><span>{count}</span></button>
      {detached && <button className="br-icon" title={word("窗口置顶","Keep window on top")} aria-label={word("窗口置顶","Keep window on top")} aria-pressed={signals.pinned} onClick={() => {
        void bridge.shell("pin",{spaceId:sessionId,pinned:!signals.pinned}).then(pinned=>setSignals(previous=>({...previous,pinned}))).catch(report);
      }}><Pin/></button>}
      <button className="br-zoom" data-custom={zoom!==100} title={word("恢复网页缩放","Reset page zoom")} aria-label={word("恢复网页缩放","Reset page zoom")} disabled={!tabId} onClick={()=>void run("zoom",{tabId,factor:1})}>{zoom}%</button>
    </>}>
    <div className="browser-navigation" data-shutter={feedback === "capture"}>
      <div className="br-navigation-group">
        <button className="br-icon" disabled={!state.canGoBack} title={word("后退","Back")} aria-label={word("后退","Back")} onClick={() => void run("back",{tabId})}><ArrowLeft/></button>
        <button className="br-icon" disabled={!state.canGoForward} title={word("前进","Forward")} aria-label={word("前进","Forward")} onClick={() => void run("forward",{tabId})}><ArrowRight/></button>
        <button className="br-icon" disabled={!page && !current?.loading} title={current?.loading ? word("停止加载","Stop loading") : word("刷新 · Shift 强刷","Reload · Shift for hard reload")} aria-label={current?.loading ? word("停止加载","Stop loading") : word("刷新网页","Reload page")} onClick={event => {
          if (current?.loading || event.shiftKey) void bridge.shell("reload",{...tab,mode:current?.loading ? "stop" : "hard"}).catch(report);
          else void run("reload",{tabId});
        }}>{current?.loading ? <X className="br-reload-change"/> : <RotateCw className="br-reload-change"/>}</button>
      </div>
      <form className="br-address" role="search" onSubmit={event => {
        event.preventDefault();
        if (choice>=0 && suggestions[choice]) void select(suggestions[choice]);
        else if (address.trim()) navigate(address);
      }}>
        <span className="br-site">{state.url.startsWith("https:") ? <LockKeyhole/> : <Globe/>}</span>
        <div className="br-address-edit">
          {!focused && parsed && <span className="br-address-display" aria-hidden>{parsed.protocol}//<b>{domain}</b>{parsed.pathname}{parsed.search}{parsed.hash}</span>}
          <input ref={addressInput} className={parsed && !focused ? "br-address-ghost" : ""} aria-label={word("网址","URL")} placeholder={word("搜索或输入网址","Search or enter address")}
            spellCheck={false} autoComplete="off" value={address} aria-autocomplete="list" aria-controls={showSuggestions ? "br-suggestions" : undefined}
            aria-activedescendant={choice>=0 && showSuggestions ? "br-suggestion-"+choice : undefined} onKeyDown={addressKeys}
            onFocus={event => {
              editing.current=true;
              setFocused(true);
              event.currentTarget.select();
              void hydrate(true);
              if (page) void bridge.panel(sessionId,"preview")
                .then(result => {if(editing.current) setCover(result?.image ?? "");})
                .catch(()=>{if(editing.current) setCover("");});
            }}
            onBlur={event => {if (!event.currentTarget.form?.contains(event.relatedTarget)) closeAddress();}}
            onChange={event => {setAddress(event.target.value);setEdited(true);setChoice(-1);}}/>
        </div>
        {page && <button type="button" className="br-icon" title={word("复制链接","Copy URL")} aria-label={word("复制链接","Copy URL")} data-copied={feedback==="copy"} onMouseDown={event=>event.preventDefault()} onClick={copy}>{feedback==="copy"?<Check/>:<Copy/>}</button>}
        {showSuggestions && <div className="br-suggestions" id="br-suggestions" role="listbox">
          {suggestions.map((item,index)=> <button key={item.key} id={"br-suggestion-"+index} type="button" role="option" aria-selected={choice===index}
            onMouseEnter={()=>setChoice(index)} onMouseDown={event=>event.preventDefault()} onClick={()=>void select(item)}>
            <Globe/><span><b>{item.title}</b><small>{item.url}</small></span><em>{item.kind}</em>
          </button>)}
        </div>}
      </form>
      <div className="br-tools">
        <button className="br-icon" disabled={!page} title={word("拾取网页元素（点击选中，↑/↓ 切换父子层级）","Pick page element (↑/↓ parent/child)")} aria-label={word("拾取网页元素","Pick element")} aria-pressed={picker==="element"} onClick={() => void startPicker("element")}><Crosshair/></button>
        <button className="br-icon" disabled={!page} title={word("框选区域截屏入聊","Capture region to chat")} aria-label={word("框选区域截屏","Capture region")} aria-pressed={picker==="region"} onClick={() => void startPicker("region")}><Crop/></button>
        <button className="br-icon" disabled={!page} title={word("整页截屏入聊","Capture full viewport to chat")} aria-label={word("整页截屏","Capture viewport")} onClick={() => void capture()}>{feedback==="capture" ? <Check/> : <Camera/>}</button>
        <span className="br-tool-divider" aria-hidden/>
        {current?.errors ? (
          <button className="br-radar" title={word("控制台 / 网络诊断","Console & network diagnostics")} aria-label={word("报错雷达","Diagnostics")} aria-pressed={diagnostics}
            onClick={() => {setDiagnostics(value=>!value);void bridge.shell("clear",{...tab,remove:false}).catch(report);}}>
            <span className="br-dot" data-tone="danger"/>{current.errors}
          </button>
        ) : (
          <button className="br-icon" disabled={!page} title={word("控制台 / 网络诊断","Console & network diagnostics")} aria-label={word("控制台诊断","Diagnostics")} aria-pressed={diagnostics}
            onClick={() => setDiagnostics(value=>!value)}><Bug/></button>
        )}
        <div className="br-device-tools" ref={deviceTools} onBlur={event=>{
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) dismissDeviceMenu();
        }} onKeyDown={event=>{
          if (!deviceMenu) return;
          if (event.key === "Escape") {event.stopPropagation();dismissDeviceMenu();event.currentTarget.querySelector("button")?.focus();}
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menu] button:not(:disabled)")];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
          }
        }}>
          <button className="br-icon" title={word("响应式视口","Responsive viewport")} aria-label={word("响应式视口","Responsive viewport")} aria-pressed={!!device} aria-haspopup="menu" aria-expanded={deviceMenu} onClick={() => void changeDevice().catch(report)}><MonitorSmartphone/></button>
          {deviceMenu && <div role="menu" className="br-device-menu" aria-label={word("视口预设","Viewport presets")}>
            {[undefined,...devices].map(item=><button key={item?.id ?? "auto"} role="menuitemradio" aria-checked={device===item} type="button" onClick={()=>void selectDevice(item).catch(report)}>
              <span>{item ? word(item.label,item.en) : word("自适应","Fit window")}</span>{item && <small>{item.width} × {item.height}</small>}{device===item && <Check/>}
            </button>)}
            <button role="menuitem" type="button" disabled={!device} onClick={()=>void selectDevice(device,!landscape).catch(report)}><span>{word("横竖屏翻转","Rotate viewport")}</span><RotateCw/></button>
          </div>}
        </div>
        <button className="br-icon" disabled={!page} title={word("打开 / 关闭开发者工具 (DevTools)","Toggle DevTools")} aria-label={word("开发者工具","DevTools")} onClick={() => void bridge.shell("devtools",tab).catch(report)}><Code2/></button>
        <span className="br-tool-divider" aria-hidden/>
        <button className="br-control" disabled={!tabId} data-mode={state.manual?"manual":active?"agent":"ready"} aria-label={control} title={control} onClick={takeControl}>
          {state.manual ? <Play/> : active ? <span className="br-dot" data-tone="blue" data-pulse/> : <Hand/>}
          <span className="br-control-label">{control}</span>
          {active && <span className="br-control-hover">{word("点击接管","Take control")}</span>}
        </button>
        <button className="br-icon" title={word("浏览器菜单","Browser menu")} aria-label={word("浏览器菜单","Browser menu")} onClick={() => void more().catch(report)}><MoreHorizontal/></button>
      </div>
      <span className="br-load-progress" data-loading={!!current?.loading} style={{transform:`scaleX(${current?.progress ?? 0})`}} aria-hidden/>
    </div>
    {picker && (
      <div className="br-picker-bar" role="status">
        <div className="br-picker-bar-copy">
          {picker === "element" ? <Crosshair aria-hidden/> : <Crop aria-hidden/>}
          <span>
            {picker === "element"
              ? word("正在拾取网页元素","Picking page element")
              : word("正在框选截屏区域","Selecting screenshot region")}
            <small>
              {picker === "element"
                ? word("· 点击选中，↑/↓ 切换父子层级，Enter 确认","· Click to select, ↑/↓ parent/child, Enter to confirm")
                : word("· 在页面拖拽框选，松开即加入对话","· Drag on page to capture")}
            </small>
          </span>
        </div>
        <button type="button" className="br-picker-cancel" onClick={() => void bridge.shell("cancel",tab).catch(report)}>
          {word("取消 (Esc)","Cancel (Esc)")}
        </button>
      </div>
    )}
    {error && <div role="alert" className="br-error">{error}<button className="br-icon" aria-label={word("关闭提示","Dismiss")} onClick={()=>setError("")}><X/></button></div>}
    {!page ? <BrowserStart key={tabId} zh={zh} data={omnibox} onOpen={navigate} onProbe={()=>hydrate(true)}/> :
      device ? <div className="br-device">
        <div className="br-device-caption">
          {word(device.label,device.en)} · {width} × {height}
          <button className="br-icon" title={word("横竖屏翻转","Rotate viewport")} aria-label={word("横竖屏翻转","Rotate viewport")} onClick={()=>void selectDevice(device,!landscape).catch(report)}><RotateCw/></button>
          <span>{Math.round(scale*100)}%</span>
          <button className="br-icon" title={word("退出设备模式","Exit device mode")} aria-label={word("退出设备模式","Exit device mode")} onClick={()=>void selectDevice(undefined).catch(report)}><X/></button>
        </div>
        <div className="br-device-area" ref={deviceArea}>{viewportContents}</div>
      </div> : viewportContents}
    {deviceTransition && <img ref={deviceShot} className="br-device-shot" src={deviceTransition.image} alt=""/>}
    {diagnostics && <BrowserDiagnostics key={tabId} issues={signals.issues} zh={zh}
      onClose={()=>setDiagnostics(false)} onClear={()=>void bridge.shell("clear",{...tab,remove:true}).catch(report)}
      onSend={async ids=>{
        try {
          const ok=await bridge.shell("draft",{...tab,issueIds:ids});
          if(ok) toast.success(word("诊断已加入会话输入框","Diagnostics added to chat draft"));
          return ok;
        } catch(err) {report(err);return false;}
      }}/>}
  </WorkspaceDrawer>;
}
