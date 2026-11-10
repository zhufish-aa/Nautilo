/** Serialized into the target's own realm; keep both functions self-contained. */
export function inspectClickTarget(this:Element) {
  const describe=(element:Element|null)=>{
    if(!element)return null;
    const classes=[...element.classList].slice(0,3);
    return {tag:element.tagName.toLowerCase(),id:element.id||undefined,classes,
      selector:element.id?"#"+CSS.escape(element.id):element.tagName.toLowerCase()+classes.map(value=>"."+CSS.escape(value)).join(""),
      role:element.getAttribute("role")??undefined,text:(element.getAttribute("aria-label")??element.textContent??"").replace(/\s+/g," ").trim().slice(0,160)};
  };
  const rect=this.getBoundingClientRect(),root=this.getRootNode() as Document|ShadowRoot;
  const x=(Math.max(0,rect.left)+Math.min(innerWidth,rect.right))/2,y=(Math.max(0,rect.top)+Math.min(innerHeight,rect.bottom))/2;
  const visible=this.isConnected && rect.right>0 && rect.bottom>0 && rect.left<innerWidth && rect.top<innerHeight && rect.width>0 && rect.height>0;
  const disabled=(this as HTMLButtonElement).disabled || this.getAttribute("aria-disabled")==="true";
  const localHit=visible && typeof root.elementFromPoint === "function"?root.elementFromPoint(x,y):null;
  const outerHit=visible?document.elementFromPoint(x,y):null;
  const contains=(target:Element,hit:Element|null)=>{
    let node=hit;
    while(node){if(node===target || target.contains(node))return true;node=(node.getRootNode() as ShadowRoot).host??null;}
    return false;
  };
  let outerMatches=false,ancestor:Element|null=this;
  while(ancestor){if(contains(ancestor,outerHit)){outerMatches=true;break;}ancestor=(ancestor.getRootNode() as ShadowRoot).host??null;}
  return {point:{x,y},actionable:!!visible && !disabled && contains(this,localHit) && outerMatches,
    visible,disabled:!!disabled,target:describe(this),hit:describe(!outerMatches?outerHit:localHit),
    shadow_root:root instanceof ShadowRoot?root.mode:undefined};
}

export function observeClickTarget(this:Element) {
  const target=this,root=target.getRootNode(),closed=root instanceof ShadowRoot && root.mode==="closed";
  const events=new Set<string>();
  let received=false,nativeSeen=false,hit:Record<string,unknown>|undefined;
  const listener=(event:Event)=>{
    if(!event.isTrusted)return;
    nativeSeen=true;
    const path=event.composedPath();
    if(path.includes(target)){received=true;events.add(event.type);}
    const element=path.find(node=>node instanceof Element) as Element|undefined;
    if(element && !received){const classes=[...element.classList].slice(0,3);hit={tag:element.tagName.toLowerCase(),
      selector:element.id?"#"+CSS.escape(element.id):element.tagName.toLowerCase()+classes.map(value=>"."+CSS.escape(value)).join(""),
      text:(element.getAttribute("aria-label")??element.textContent??"").replace(/\s+/g," ").trim().slice(0,160)};}
  };
  // A document listener sees closed-shadow hosts instead of the actual target.
  // Observe inside the same root and on the node before dispatching any input.
  const scopes=[...new Set<EventTarget>([target,root,document])],types=["pointerdown","mousedown","click"];
  for(const scope of scopes)for(const type of types)scope.addEventListener(type,listener,true);
  return {receipt:()=>({received,nativeSeen,events:[...events],hit,closed}),
    dispose:()=>{for(const scope of scopes)for(const type of types)scope.removeEventListener(type,listener,true);}};
}
