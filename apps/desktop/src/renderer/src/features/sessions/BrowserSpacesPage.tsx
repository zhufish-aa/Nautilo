import { useEffect, useRef, useState } from "react";
import { ChevronDown, Keyboard, LoaderCircle, Pencil, Plus, RefreshCw, Globe } from "lucide-react";
import { WindowControls } from "../../components/layout/TitleBar";
import { NautiloMark } from "../../components/ui/IdentityAvatar";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import type { BrowserSpace, BrowserSpacesState } from "../../../../shared/browser-spaces";
import "./browser-spaces.css";
import { BrowserLoginDialog } from "./BrowserLoginDialog";
import { LogIn } from "lucide-react";

export default function BrowserSpacesPage({onOpen,active=true}:{onOpen?:(space:BrowserSpace,rect?:DOMRect,keyboard?:boolean)=>Promise<void>;active?:boolean}) {
  const app = getBridge()!, browser = app.browser!;
  const { locale } = useI18n(), zh = locale === "zh-CN";
  const [spaces, setSpaces] = useState<BrowserSpace[]>([]);
  const [error, setError] = useState("");
  const [loginOpen,setLoginOpen]=useState(false);
  const [filter, setFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [opening, setOpening] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const grid = useRef<HTMLDivElement>(null);
  const alive = useRef(true), revision = useRef(0), visible = useRef<string[]>([]);
  const activeRef=useRef(active);activeRef.current=active;
  visible.current = visibleIds;
  const report = (value: unknown) => { if (alive.current) setError(value instanceof Error ? value.message : String(value)); };
  const apply = (next: BrowserSpacesState) => setSpaces(previous => {
    const cached = new Map(previous.map(space => [space.id, space.preview]));
    return next.spaces.map(space => ({...space,preview:space.preview || cached.get(space.id)}));
  });
  const refresh = async () => {
    const version = revision.current;
    try {
      const next = await browser.spaces("list");
      if (alive.current && version === revision.current) { apply(next); setError(""); }
    } catch (error) { report(error); }
  };
  const previews = async (ids: string[]) => {
    if (!ids.length || document.hidden || !activeRef.current) return;
    try {
      // Load only visible cards. A preview response never overwrites newer names/status.
      for (let index = 0; index < ids.length; index += 12) {
        const next = await browser.spaces("list", {previews:true, ids:ids.slice(index,index+12)});
        if (!alive.current) return;
        const images = new Map(next.spaces.map(space => [space.id,space.preview]));
        setSpaces(current => current.map(space => ({...space,preview:images.get(space.id) || space.preview})));
      }
    } catch (error) { report(error); }
  };

  useEffect(() => {
    alive.current = true;
    void refresh();
    const metadata = setInterval(() => { if (!document.hidden && activeRef.current) void refresh(); }, 2500);
    const images = setInterval(() => void previews(visible.current), 5000);
    const activate = () => { if (!document.hidden) { void refresh(); void previews(visible.current); } };
    document.addEventListener("visibilitychange", activate);
    return () => { alive.current = false; clearInterval(metadata); clearInterval(images); document.removeEventListener("visibilitychange",activate); };
  }, [browser]);
  useEffect(()=>{if(active){void refresh();void previews(visible.current);}},[active]);

  const shown = spaces.filter(space => filter === "all" || (filter === "open" ? space.open : space.status === "running" || space.status === "agent"));
  const key = shown.map(space => space.id).join("|");
  useEffect(() => {
    const ids = new Set<string>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.spaceId!;
        entry.isIntersecting ? ids.add(id) : ids.delete(id);
      }
      setVisibleIds([...ids]);
    }, {rootMargin:"100px"});
    grid.current?.querySelectorAll("[data-space-id]").forEach(card => observer.observe(card));
    return () => observer.disconnect();
  }, [key]);
  useEffect(() => { void previews(visibleIds); }, [visibleIds.join("|")]);
  useEffect(() => {
    if (!filterOpen) return;
    const close = (event: PointerEvent) => { if (!(event.target as Element).closest(".spaces-filter")) setFilterOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setFilterOpen(false); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown",escape);
    return () => { document.removeEventListener("pointerdown",close); document.removeEventListener("keydown",escape); };
  }, [filterOpen]);

  const open = async (id: string,keyboard=false) => {
    if (opening) return;
    setOpening(id);
    try {
      const space=spaces.find(space=>space.id === id);
      const rect=grid.current?.querySelector(`[data-space-id="${CSS.escape(id)}"] .spaces-window-preview`)?.getBoundingClientRect();
      if(onOpen && space)await onOpen(space,rect,keyboard);
      else await app.panels!.open({kind:"browser",sessionId:id});
      await refresh();
    }
    catch (error) { report(error); }
    finally { if (alive.current) setOpening(undefined); }
  };
  const create = async () => {
    if (creating) return;
    setCreating(true); revision.current++;
    try {
      const next = await browser.spaces("create");
      if (!alive.current) return;
      apply(next);
      if (next.createdId) await open(next.createdId);
    } catch (error) { report(error); }
    finally { if (alive.current) setCreating(false); }
  };
  const rename = async (space: BrowserSpace, value: string) => {
    setEditing(undefined);
    const nextName = value.trim();
    if (!nextName || nextName === space.name) return;
    revision.current++;
    try { const next = await browser.spaces("rename",{id:space.id,name:nextName}); if (alive.current) apply(next); }
    catch (error) { report(error); }
  };
  const status = (space: BrowserSpace) => space.status === "running" ? (zh ? "运行中" : "Running") : space.status === "agent" ? (zh ? "AI 控制中" : "Agent in control") : space.status === "user" ? (zh ? "你正在控制" : "Your control") : space.status === "stopped" ? (zh ? "已停止" : "Stopped") : "";

  return <section className="browser-spaces-surface" aria-label={zh ? "浏览器窗口总览" : "Browser windows"}>
    <header className="spaces-caption drag-region">
      <div className="spaces-wordmark"><NautiloMark/><span>Nautilo</span></div>
      <div className="spaces-filter no-drag">
        <button type="button" className="spaces-filter-trigger" aria-haspopup="menu" aria-expanded={filterOpen} onClick={() => setFilterOpen(value => !value)}>
          {filter === "all" ? (zh ? `${spaces.length} 个窗口` : `${spaces.length} windows`) : filter === "open" ? (zh ? "已打开" : "Open windows") : (zh ? "AI 运行中" : "Agent activity")}<ChevronDown size={12}/>
        </button>
        {filterOpen && <div role="menu" className="spaces-filter-menu">{[["all",zh ? "全部窗口" : "All windows"],["open",zh ? "已打开" : "Open windows"],["active",zh ? "AI 运行中" : "Agent activity"]].map(([value,label]) => <button key={value} type="button" role="menuitemradio" aria-checked={filter === value} onClick={() => {setFilter(value);setFilterOpen(false);}}>{label}<span>{filter === value ? "✓" : ""}</span></button>)}</div>}
      </div>
      <div className="spaces-caption-actions no-drag">
        <button className="spaces-icon" title={zh?"浏览器登录态":"Browser sign-in"} aria-label={zh?"浏览器登录态":"Browser sign-in"} onClick={()=>setLoginOpen(true)}><LogIn size={15}/></button>
        <button className="spaces-icon" aria-label={zh ? "刷新窗口预览" : "Refresh previews"} title={zh ? "刷新窗口预览" : "Refresh previews"} onClick={() => {void refresh();void previews(visible.current);}}><RefreshCw size={15}/></button>
        <WindowControls/>
      </div>
    </header>
    {error && <div className="spaces-error" role="alert">{error}</div>}
    <BrowserLoginDialog open={loginOpen} onClose={()=>setLoginOpen(false)} zh={zh}/>
    <div className="spaces-scroll">
      <div ref={grid} className="spaces-window-grid">
        {shown.map(space => <article key={space.id} data-space-id={space.id} className="spaces-window-card" data-running={space.status === "running" || space.status === "agent"} data-active={space.active}>
          <button type="button" className="spaces-window-preview" aria-label={(zh ? "打开窗口 " : "Open window ") + space.name} onClick={event => void open(space.id,event.detail === 0)}>
            {space.preview ? <img src={space.preview} alt="" draggable={false}/> : <div className="spaces-window-empty"><Globe size={32}/><span>{space.url && space.url !== "about:blank" ? space.url : space.name}</span></div>}
            {opening === space.id && <span className="spaces-opening"><LoaderCircle size={16}/></span>}
            {space.active && <span className="spaces-active-marker"/>}
          </button>
          <div className="spaces-window-caption">
            {(space.status === "running" || space.status === "agent") && <span className="spaces-running">{status(space)}</span>}
            {editing === space.id ? <input autoFocus className="spaces-name-input" aria-label={zh ? "窗口名称" : "Window name"} maxLength={120} value={name} onFocus={event => event.target.select()} onChange={event => setName(event.target.value)} onBlur={event => void rename(space,event.currentTarget.value)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") {event.currentTarget.value=space.name;setEditing(undefined);} }}/> : <button type="button" className="spaces-window-name" title={space.name} onClick={event => void open(space.id,event.detail === 0)}>{space.name}</button>}
            <button type="button" className="spaces-rename" aria-label={(zh ? "重命名窗口 " : "Rename window ") + space.name} title={zh ? "重命名" : "Rename"} onClick={() => {setName(space.name);setEditing(space.id);}}><Pencil size={11}/></button>
            <span className="spaces-tab-count">{zh ? `${space.tabCount} 个标签` : `${space.tabCount} tabs`}</span>
          </div>
        </article>)}
        <button type="button" className="spaces-window-new" disabled={creating} onClick={() => void create()} title={zh ? "新建独立窗口" : "New independent window"} aria-label={zh ? "新建独立窗口" : "New independent window"}>{creating ? <LoaderCircle size={32}/> : <Plus size={36}/>}</button>
      </div>
    </div>
    {spaces.filter(space => space.open).length > 1 && <div className="spaces-shortcut"><Keyboard size={17}/><span><kbd>Alt</kbd> + <kbd>S</kbd></span><span>{zh ? "切换已打开的窗口" : "Switch open windows"}</span></div>}
  </section>;
}
