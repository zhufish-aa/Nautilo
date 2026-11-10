import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getBridge } from "../../lib/bridge";
import type { PanelTarget } from "../../../../shared/panel-window";
import type { BrowserSpace } from "../../../../shared/browser-spaces";
import { BrowserDrawer } from "./BrowserDrawer";
import BrowserSpacesPage from "./BrowserSpacesPage";
import "./browser-spaces.css";

type Zoom = {id:string; image:string; card:DOMRect; direction:"in"|"out"; serial:number};
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Native pages stay alive offscreen. Only the browser shell and its preview move. */
export function BrowserHost({initialTarget}:{initialTarget:PanelTarget}) {
  const app=getBridge()!, bridge=app.browser!;
  const [selected,setSelected]=useState(initialTarget.sessionId);
  const [zoom,setZoom]=useState<Zoom>();
  const [error,setError]=useState("");
  const root=useRef<HTMLDivElement>(null), page=useRef<HTMLDivElement>(null), shot=useRef<HTMLImageElement>(null);
  const current=useRef(selected), serial=useRef(0), animation=useRef<Animation>();
  const intent=useRef<{id:string;image?:string;card?:DOMRect;keyboard?:boolean;out?:boolean}>();
  const onTarget=useRef<(target:PanelTarget)=>void>(()=>{});
  current.current=selected;

  onTarget.current=target=>{
    const id=target.kind === "browser" ? target.sessionId : undefined;
    if(id === current.current)return;
    const next=intent.current;
    intent.current=undefined;
    const revision=++serial.current;
    animation.current?.cancel();
    const animated=next && !next.keyboard && !reducedMotion() && next.image && next.card && next.card.width>0;
    setZoom(animated ? {id:next.id,image:next.image!,card:next.card!,direction:next.out?"out":"in",serial:revision} : undefined);
    current.current=id;
    setSelected(id);
    setError("");
  };
  useEffect(()=>{
    let alive=true,received=false;
    const stop=app.panels!.onBrowserTarget(target=>{received=true;onTarget.current(target);});
    void app.panels!.current().then(target=>{if(alive && !received && target)onTarget.current(target);}).catch(()=>{});
    return()=>{alive=false;stop();};
  },[app.panels]);

  const open=async(space:BrowserSpace,card?:DOMRect,keyboard=false)=>{
    intent.current={id:space.id,image:space.preview,card,keyboard};
    try {await app.panels!.open({kind:"browser",sessionId:space.id});}
    catch(error){intent.current=undefined;throw error;}
  };
  const back=async(keyboard=false)=>{
    const id=current.current;
    if(!id)return;
    const revision=serial.current;
    try {
      const card=root.current?.querySelector(`[data-space-id="${CSS.escape(id)}"] .spaces-window-preview`);
      let image:string|undefined;
      if(!keyboard && !reducedMotion())image=(await bridge.panel(id,"preview"))?.image;
      if(current.current !== id || serial.current !== revision)return;
      // The overview remains mounted, retaining its scroll and card positions.
      // Its layer is made measurable before taking the reverse destination.
      const overview=root.current?.querySelector<HTMLElement>(".browser-host-overview");
      if(overview)overview.hidden=false;
      const rect=card?.getBoundingClientRect();
      intent.current={id,image,card:rect,keyboard,out:true};
      await app.panels!.open({kind:"browser-spaces"});
    } catch(error){setError(error instanceof Error?error.message:String(error));}
  };

  useLayoutEffect(()=>{
    if(!zoom || !page.current || !shot.current)return;
    const element=page.current, viewport=element.querySelector<HTMLElement>("[data-browser-viewport]");
    if(!viewport){setZoom(undefined);return;}
    const bounds=element.getBoundingClientRect(), content=viewport.getBoundingClientRect();
    Object.assign(shot.current.style,{left:`${content.x-bounds.x}px`,top:`${content.y-bounds.y}px`,width:`${content.width}px`,height:`${content.height}px`});
    const small=`translate(${zoom.card.x-bounds.x}px,${zoom.card.y-bounds.y}px) scale(${zoom.card.width/bounds.width},${zoom.card.height/bounds.height})`;
    const smallFrame={transform:small,opacity:1}, largeFrame={transform:"translate(0px,0px) scale(1,1)",opacity:1};
    element.style.transformOrigin="0 0";
    const effect=element.animate(zoom.direction === "in" ? [smallFrame,largeFrame] : [largeFrame,smallFrame],{
      duration:240,easing:"cubic-bezier(0.23,1,0.32,1)",fill:"both",
    });
    animation.current=effect;
    let disposed=false;
    void effect.finished.then(async()=>{
      if(disposed || serial.current !== zoom.serial)return;
      if(zoom.direction === "in" && current.current === zoom.id) {
        // Reveal the native surface before removing its preview, avoiding a white flash.
        const rect=viewport.getBoundingClientRect();
        await bridge.panel(zoom.id,"layout",{x:rect.x,y:rect.y,width:rect.width,height:rect.height}).catch(()=>{});
      }
      if(!disposed && serial.current === zoom.serial)setZoom(undefined);
    }).catch(()=>{});
    return ()=>{disposed=true;effect.cancel();if(animation.current === effect)animation.current=undefined;};
  },[zoom,bridge]);
  useEffect(()=>{
    const resize=()=>{++serial.current;animation.current?.cancel();setZoom(undefined);};
    window.addEventListener("resize",resize);
    return()=>{window.removeEventListener("resize",resize);animation.current?.cancel();};
  },[]);

  const displayed=selected ?? (zoom?.direction === "out" ? zoom.id : undefined);
  return <div ref={root} className="browser-host">
    <div className="browser-host-overview" hidden={!!selected && !zoom}><BrowserSpacesPage active={!selected} onOpen={open}/></div>
    {displayed && <div ref={page} className="browser-host-page" data-zooming={!!zoom}>
      <BrowserDrawer key={displayed} sessionId={displayed} surfaceSuspended={!!zoom} onClose={()=>void back(true)} onOverview={keyboard=>void back(keyboard)}/>
      {zoom && <img ref={shot} className="browser-host-shot" src={zoom.image} alt="" draggable={false}/>}
    </div>}
    {error && <div className="browser-host-error" role="alert">{error}</div>}
  </div>;
}
