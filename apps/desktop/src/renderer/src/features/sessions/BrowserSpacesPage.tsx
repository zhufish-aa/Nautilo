import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowUpRight, Check, Globe, LoaderCircle, LogIn, Pencil, Plus, RefreshCw,
  Search, SquareCheck, Trash2, X,
} from "lucide-react";
import { WindowControls } from "../../components/layout/TitleBar";
import { NautiloMark } from "../../components/ui/IdentityAvatar";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { useUiReducedMotion } from "../../lib/ui-motion";
import type { BrowserSpace, BrowserSpacesState } from "../../../../shared/browser-spaces";
import { BrowserLoginDialog } from "./BrowserLoginDialog";
import { browserDomain } from "./BrowserDrawer";
import "./browser-spaces.css";

const activity = (space:BrowserSpace) => space.status === "running" || space.status === "agent";
const filters = [
  {id:"all",cn:"全部",en:"All",matches:(_space:BrowserSpace)=>true},
  {id:"loaded",cn:"已加载网页",en:"Loaded",matches:(space:BrowserSpace)=>space.loaded},
  {id:"active",cn:"AI 活跃中",en:"AI active",matches:activity},
  {id:"errors",cn:"有报错",en:"Errors",matches:(space:BrowserSpace)=>space.errors>0},
  {id:"blank",cn:"空白窗口",en:"Blank",matches:(space:BrowserSpace)=>!space.loaded},
] as const;
const previewsOnly = (space:BrowserSpace) => !!space.url && space.url !== "about:blank";

export default function BrowserSpacesPage({onOpen,active=true}:{
  onOpen?:(space:BrowserSpace,rect?:DOMRect,keyboard?:boolean)=>Promise<void>;active?:boolean;
}) {
  const app = getBridge()!, browser = app.browser!;
  const zh = useI18n().locale === "zh-CN";
  const word = (cn:string,en:string) => zh ? cn : en;
  const reducedMotion = useUiReducedMotion();
  const [spaces,setSpaces] = useState<BrowserSpace[]>([]);
  const [error,setError] = useState("");
  const [loginOpen,setLoginOpen] = useState(false);
  const [filter,setFilter] = useState<typeof filters[number]["id"]>("all");
  const [query,setQuery] = useState("");
  const [selecting,setSelecting] = useState(false);
  const [selected,setSelected] = useState<Set<string>>(() => new Set());
  const [closing,setClosing] = useState<string[]>([]);
  const [opening,setOpening] = useState<string>();
  const [creating,setCreating] = useState(false);
  const [refreshing,setRefreshing] = useState(false);
  const [editing,setEditing] = useState<string>();
  const [name,setName] = useState("");
  const [visibleIds,setVisibleIds] = useState<string[]>([]);
  const grid = useRef<HTMLDivElement>(null);
  const beforeClose = useRef<Map<string,{x:number;y:number}>>();
  const search = useRef<HTMLInputElement>(null);
  const mounted = useRef(true), revision = useRef(0), visible = useRef<string[]>([]);
  const mutating = useRef(false), refreshingMetadata = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  visible.current = visibleIds;
  const report = (value:unknown) => {if (mounted.current) setError(value instanceof Error ? value.message : String(value));};
  const apply = (next:BrowserSpacesState) => setSpaces(previous => {
    const cached = new Map(previous.map(space=>[space.id,space]));
    return next.spaces.map(space=>{
      const before=cached.get(space.id);
      return {...space,preview:previewsOnly(space) ? space.preview ?? (before?.url===space.url ? before.preview : undefined) : undefined};
    });
  });
  const refresh = async () => {
    if (mutating.current || refreshingMetadata.current) return;
    const version = revision.current;
    refreshingMetadata.current = true;
    try {
      const next = await browser.spaces("list");
      if (mounted.current && version === revision.current) apply(next);
    } catch (err) {report(err);}
    finally {refreshingMetadata.current=false;}
  };
  const previews = async (ids:string[]) => {
    if (!ids.length || document.hidden || !activeRef.current) return;
    try {
      for (let index=0;index<ids.length;index+=12) {
        const next = await browser.spaces("list",{previews:true,ids:ids.slice(index,index+12)});
        if (!mounted.current) return;
        const images = new Map(next.spaces.filter(previewsOnly).map(space=>[space.id,space]));
        setSpaces(current=>current.map(space=>{
          const fresh = images.get(space.id);
          return fresh?.preview && fresh.url===space.url ? {...space,preview:fresh.preview} : space;
        }));
      }
    } catch (err) {report(err);}
  };
  useEffect(() => {
    mounted.current=true;
    void refresh();
    const metadata = setInterval(() => {if (!document.hidden && activeRef.current) void refresh();},2500);
    const images = setInterval(() => void previews(visible.current),5000);
    const unsubscribe = browser.onShellChange(event=>{
      if (!document.hidden && activeRef.current && !event.focusAddress) void refresh();
    });
    const onKey = (event:globalThis.KeyboardEvent) => {
      if (!activeRef.current || event.key !== "/" || event.ctrlKey || event.altKey || event.metaKey ||
          event.target instanceof Element && event.target.closest("input,textarea,[contenteditable]")) return;
      event.preventDefault();
      search.current?.focus();
    };
    document.addEventListener("keydown",onKey);
    return () => {mounted.current=false;clearInterval(metadata);clearInterval(images);unsubscribe();document.removeEventListener("keydown",onKey);};
  },[browser]);
  useEffect(()=>{if(active){void refresh();void previews(visible.current);}},[active]);

  const term = query.trim().toLowerCase();
  const shown = spaces.filter(space=>filters.find(item=>item.id===filter)!.matches(space)
    && (!term || [space.name,space.title,space.url].some(value=>value.toLowerCase().includes(term))));
  const blank = spaces.filter(space=>!space.loaded && !activity(space)).map(space=>space.id);
  const visibleKey = shown.map(space=>space.id).join("|");
  useLayoutEffect(() => {
    const previous = beforeClose.current;
    if (!previous) return;
    beforeClose.current = undefined;
    if (reducedMotion) return;
    for (const card of grid.current?.querySelectorAll<HTMLElement>("[data-space-id]") ?? []) {
      const start = previous.get(card.dataset.spaceId!);
      if (!start) continue;
      const x = start.x-card.offsetLeft, y = start.y-card.offsetTop;
      if (x || y) card.animate([{translate:`${x}px ${y}px`},{translate:"0px 0px"}],{
        duration:220,easing:"cubic-bezier(.22,1,.36,1)",
      });
    }
  },[visibleKey,reducedMotion]);
  useEffect(() => {
    const ids = new Set<string>();
    if (!active) return;
    const observer = new IntersectionObserver(entries=>{
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.spaceId!;
        if (entry.isIntersecting) ids.add(id);
        else ids.delete(id);
      }
      setVisibleIds([...ids]);
    },{rootMargin:"100px"});
    grid.current?.querySelectorAll("[data-space-id]").forEach(card=>observer.observe(card));
    return ()=>observer.disconnect();
  },[visibleKey,active]);
  useEffect(()=>{void previews(visibleIds);},[visibleIds.join("|")]);

  const open = async (space:BrowserSpace,keyboard=false) => {
    if (opening || closing.includes(space.id)) return;
    setOpening(space.id);
    try {
      const rect=grid.current?.querySelector(`[data-space-id="${CSS.escape(space.id)}"] .spaces-window-preview`)?.getBoundingClientRect();
      if (onOpen) await onOpen(space,rect,keyboard);
      else await app.panels!.open({kind:"browser",sessionId:space.id});
      void refresh();
    } catch (err) {report(err);}
    finally {if (mounted.current) setOpening(undefined);}
  };
  const create = async () => {
    if (creating) return;
    setCreating(true);
    revision.current++;
    try {
      const next = await browser.spaces("create");
      if (!mounted.current) return;
      apply(next);
      const created = next.spaces.find(space=>space.id===next.createdId);
      if (created) await open(created);
    } catch (err) {report(err);}
    finally {if (mounted.current) setCreating(false);}
  };
  const rename = async (space:BrowserSpace,value:string) => {
    setEditing(undefined);
    const next = value.trim();
    if (!next || next===space.name) return;
    revision.current++;
    try {apply(await browser.spaces("rename",{id:space.id,name:next}));}
    catch (err) {report(err);}
  };
  const close = async (ids:string[],blankOnly=false) => {
    if (!ids.length || mutating.current) return;
    mutating.current=true;
    const revisionAtClose = ++revision.current;
    try {
      const removed = await browser.shell("close",{ids,blankOnly});
      if (!mounted.current) return;
      if (!reducedMotion && removed.length) {
        setClosing(removed);
        await new Promise(resolve=>setTimeout(resolve,160));
      }
      if (mounted.current && revision.current===revisionAtClose) {
        if (!reducedMotion && removed.length) {
          beforeClose.current = new Map([...grid.current?.querySelectorAll<HTMLElement>("[data-space-id]") ?? []]
            .filter(card => !removed.includes(card.dataset.spaceId!))
            .map(card => [card.dataset.spaceId!,{x:card.offsetLeft,y:card.offsetTop}]));
        }
        setSpaces(previous=>previous.filter(space=>!removed.includes(space.id)));
        setSelected(previous=>new Set([...previous].filter(id=>!removed.includes(id))));
      }
    } catch (err) {report(err);}
    finally {mutating.current=false;setClosing([]);void refresh();}
  };
  const toggle = (id:string) => setSelected(previous=>{
    const next=new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const cardKey = (event:KeyboardEvent<HTMLButtonElement>,index:number) => {
    if (event.key === "Delete") {event.preventDefault();void close([shown[index].id]);return;}
    const cards=[...grid.current!.querySelectorAll<HTMLButtonElement>(".spaces-window-preview")];
    let next: number | undefined;
    if (event.key==="ArrowLeft") next=index-1;
    if (event.key==="ArrowRight") next=index+1;
    if (event.key==="ArrowUp" || event.key==="ArrowDown") {
      const first = cards[0].getBoundingClientRect().top;
      const columns = cards.filter(card=>Math.abs(card.getBoundingClientRect().top-first)<5).length;
      next=index+(event.key==="ArrowDown" ? columns : -columns);
    }
    if (next===undefined) return;
    event.preventDefault();
    cards[Math.min(cards.length-1,Math.max(0,next))]?.focus();
  };
  return <section className="browser-spaces-surface" aria-label={word("浏览器窗口总览","Browser windows")}>
    <header className="spaces-caption drag-region">
      <div className="spaces-wordmark"><NautiloMark/><h1>{word("浏览器窗口总览","Browser windows")}</h1><span>{spaces.length}</span></div>
      <span className="spaces-activity"><span className="br-dot" data-tone="blue" data-pulse={spaces.some(activity)}/>{spaces.filter(activity).length} {word("活跃","active")}</span>
      <div className="spaces-caption-actions no-drag">
        {!!blank.length && <button className="spaces-action spaces-clean" title={word("清理空白窗口","Close blank windows")} aria-label={word("清理空白窗口","Close blank windows")} disabled={!!closing.length} onClick={()=>void close(blank,true)}><Trash2/><span>{word("清理空白","Close blank")} {blank.length}</span></button>}
        <button className="spaces-action" title={word("多选管理","Select windows")} aria-label={word("多选管理","Select windows")} aria-pressed={selecting}
          onClick={()=>{setSelecting(value=>!value);setSelected(new Set());}}><SquareCheck/><span>{word("多选","Select")}</span></button>
        {selecting && !!selected.size && <button className="spaces-action spaces-clean" disabled={!!closing.length} onClick={()=>void close([...selected])}><X/><span>{word("关闭","Close")} {selected.size}</span></button>}
        <button className="spaces-action" disabled={creating} title={word("新建独立窗口","New independent window")} aria-label={word("新建独立窗口","New independent window")} onClick={()=>void create()}>{creating?<LoaderCircle className="browser-tab-loading"/>:<Plus/>}<span>{word("新建","New")}</span></button>
        <button className="br-icon" title={word("浏览器登录态","Browser sign-in")} aria-label={word("浏览器登录态","Browser sign-in")} onClick={()=>setLoginOpen(true)}><LogIn/></button>
        <button className="br-icon" title={word("刷新缩略图","Refresh previews")} aria-label={word("刷新缩略图","Refresh previews")} disabled={refreshing} onClick={()=>{
          setRefreshing(true);
          void Promise.all([refresh(),previews(visible.current)]).finally(()=>setTimeout(()=>setRefreshing(false),320));
        }}><RefreshCw className={refreshing?"spaces-refreshing":undefined}/></button>
        <WindowControls/>
      </div>
    </header>
    <div className="spaces-filterbar">
      <div className="spaces-filters" aria-label={word("筛选窗口","Filter windows")} role="group">
        {filters.map(item=><button key={item.id} type="button" aria-pressed={item.id===filter} onClick={()=>setFilter(item.id)}>{word(item.cn,item.en)} <span>{spaces.filter(item.matches).length}</span></button>)}
      </div>
      <label className="spaces-search"><Search/><input ref={search} aria-label={word("搜索窗口","Search windows")} placeholder={word("搜索窗口、网址…","Search windows, URLs…")} value={query} onChange={event=>setQuery(event.target.value)}/><kbd>/</kbd></label>
    </div>
    {error && <div className="br-error" role="alert">{error}<button className="br-icon" aria-label={word("关闭提示","Dismiss")} onClick={()=>setError("")}><X/></button></div>}
    <BrowserLoginDialog open={loginOpen} onClose={()=>setLoginOpen(false)} zh={zh}/>
    <div className="spaces-scroll">
      {shown.length===0 ? <p className="spaces-empty-state">{word(spaces.length ? "没有符合条件的窗口" : "还没有浏览窗口",spaces.length ? "No matching windows" : "No browser windows yet")}</p> :
        <div ref={grid} className="spaces-window-grid">
          {shown.map((space,index)=>{
            const tone=space.errors ? "danger" : activity(space) ? "blue" : space.loaded ? "green" : "";
            const loaded=previewsOnly(space), domain=browserDomain(space.url);
            const checked=selected.has(space.id);
            return <article key={space.id} data-space-id={space.id} className="spaces-window-card" data-closing={closing.includes(space.id)} data-picked={checked}
              style={{"--br-entry-delay":`${Math.min(index,11)*24}ms`} as React.CSSProperties}
              onPointerMove={event=>{
                const rect=event.currentTarget.getBoundingClientRect();
                event.currentTarget.style.setProperty("--br-spot-x",`${event.clientX-rect.left}px`);
                event.currentTarget.style.setProperty("--br-spot-y",`${event.clientY-rect.top}px`);
              }}>
              <button type="button" className="spaces-window-preview" aria-label={word("打开窗口 ","Open window ")+space.name}
                aria-pressed={selecting ? checked : undefined} onKeyDown={event=>cardKey(event,index)}
                onClick={event=>selecting ? toggle(space.id) : void open(space,event.detail===0)}>
                {loaded && space.preview ? <img className="spaces-shot" src={space.preview} alt="" draggable={false}/> :
                  <div className="spaces-window-empty"><Globe/><span>{loaded ? word("预览暂不可用","No preview yet") : word("待命 · 空白页","Ready · Blank page")}</span></div>}
                {loaded && <span className="spaces-mini-chrome">{space.favicon?<img src={space.favicon} alt=""/>:<Globe/>}<span>{domain || space.title}</span></span>}
                {opening===space.id && <span className="spaces-opening"><LoaderCircle className="browser-tab-loading"/></span>}
                {selecting && <span className="spaces-check" data-checked={checked}>{checked && <Check/>}</span>}
              </button>
              {!selecting && <>
                <button className="br-icon spaces-close-card" aria-label={word("关闭窗口 ","Close window ")+space.name} title={word("关闭窗口","Close window")} onClick={()=>void close([space.id])}><X/></button>
                <div className="spaces-preview-actions">
                  <button onClick={()=>void open(space)}>{word("进入窗口","Enter window")}</button>
                  {space.hasSession && <button onClick={()=>void browser.shell("locate",{spaceId:space.id}).catch(report)}>{word("定位原会话","Go to conversation")} <ArrowUpRight/></button>}
                </div>
              </>}
              <div className="spaces-window-caption">
                <span className="br-dot" data-tone={tone} data-pulse={tone==="blue"} aria-hidden/>
                {editing===space.id ? <input autoFocus className="spaces-name-input" aria-label={word("窗口名称","Window name")} maxLength={120} value={name}
                  onFocus={event=>event.target.select()} onChange={event=>setName(event.target.value)} onBlur={event=>void rename(space,event.currentTarget.value)}
                  onKeyDown={event=>{if(event.key==="Enter")event.currentTarget.blur();if(event.key==="Escape"){event.currentTarget.value=space.name;setEditing(undefined);}}}/> :
                  <button className="spaces-window-name" title={space.name} onClick={()=>selecting ? toggle(space.id) : void open(space,true)}>{space.name}</button>}
                {!selecting && <button className="br-icon spaces-rename" aria-label={word("重命名窗口 ","Rename window ")+space.name} title={word("重命名","Rename")} onClick={()=>{setName(space.name);setEditing(space.id);}}><Pencil/></button>}
                <span className="spaces-tab-count">{space.tabCount>1 ? word(`${space.tabCount} 标签`,`${space.tabCount} tabs`) : domain || word("空白","Blank")}</span>
              </div>
            </article>;
          })}
        </div>}
    </div>
  </section>;
}
