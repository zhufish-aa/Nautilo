import type { WebContents } from "electron";
import { BrowserToolError, browserDeadline } from "./browser-errors";
import { browserCommand } from "./browser-protocol";
import {browserFrameProtocol} from "./browser-frame-protocol";

export type BrowserTarget = {
  selector?: string;
  text?: string;
  exact?: boolean;
  selection?: "nearest";
  within?: string;
  xpath?: string;
  href?: string;
  nth?: number;
  allowHidden?: boolean;
  frame?: string|number;
  mainOnly?: boolean;
  role?:string;
  name?:string;
};

// Serialized into an isolated browser world. Keep this function self-contained.
export function findBrowserElements(target: BrowserTarget): Element[] {
  const matches: Element[] = [];
  const roots: (Document | ShadowRoot)[] = [document];
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const wanted = normalize(target.text ?? "");
  if (target.xpath) {
    const result = document.evaluate(target.xpath, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE);
    let node: Node | null;
    while ((node = result.iterateNext()) && matches.length < 200) if (node instanceof Element) matches.push(node);
    return matches;
  }
  const textMatches = (value: string) =>
    target.exact === false
      ? normalize(value).includes(wanted)
      : normalize(value) === wanted;
  for (const root of roots) {
    const roles:Record<string,string>={button:'button,input[type=button],input[type=submit],[role=button]',link:'a[href],[role=link]',textbox:'input:not([type=hidden]),textarea,[contenteditable=true],[role=textbox]',checkbox:'input[type=checkbox],[role=checkbox]',combobox:'select,[role=combobox]'};
    const elements = root.querySelectorAll(target.selector ?? (target.role ? roles[target.role] ?? '[role="'+CSS.escape(target.role)+'"]' : target.href ? "a[href]" : "*"));
    // Find open shadow roots once; native CSS selection avoids testing every node with matches().
    if (target.selector || target.href) for (const element of root.querySelectorAll("*")) if (element.shadowRoot) roots.push(element.shadowRoot);
    for (const element of elements) {
      if (!target.selector && !target.href && element.shadowRoot) roots.push(element.shadowRoot);
      if (element.closest("[data-nautilo-pointer]")) continue;
      if (target.within) {
        let parent: Element | null = element,
          inside = false;
        while (parent) {
          if (parent.matches(target.within)) {
            inside = true;
            break;
          }
          parent =
            parent.parentElement ??
            (parent.getRootNode() as ShadowRoot).host ??
            null;
        }
        if (!inside) continue;
      }
      if(target.role) {
        const input=element as HTMLInputElement;
        const label=element.getAttribute('aria-label') ?? (element.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>document.getElementById(id)?.textContent??'').join(' ')) ?? input.labels?.[0]?.textContent ?? element.textContent ?? '';
        if(target.name === undefined || normalize(label) === normalize(target.name))matches.push(element);
      } else if (target.selector) {
        matches.push(element);
      } else if (target.href) {
        if (element.getAttribute("href") === target.href || (element as HTMLAnchorElement).href === target.href) matches.push(element);
      } else if (wanted && textMatches(element.textContent ?? "")) {
        const deeper = Array.from(element.children).some((child) =>
          textMatches(child.textContent ?? ""),
        );
        if (!deeper) matches.push(element);
      }
    }
  }
  return matches;
}

function inspectRegions(locate: typeof findBrowserElements) {
  const deadline = performance.now() + 750;
  const regions = locate({
    selector: "main,article,section,[role=region],[role=main],[id]",
  });
  const output = [];
  const emitted = new Set<string>();
  const counts = new Map<string, number>();
  const roots = [
    ...new Set(
      locate({ selector: "*" }).map(
        (element) => element.getRootNode() as Document | ShadowRoot,
      ),
    ),
  ];
  const count = (selector: string) => {
    if (!counts.has(selector))
      counts.set(
        selector,
        roots.reduce(
          (total, root) => total + root.querySelectorAll(selector).length,
          0,
        ),
      );
    return counts.get(selector)!;
  };
  for (const element of regions) {
    if (performance.now() > deadline) break;
    const css = getComputedStyle(element),
      rect = element.getBoundingClientRect();
    if (
      !rect.width ||
      !rect.height ||
      css.visibility !== "visible" ||
      css.display === "none"
    )
      continue;
    const scrollable =
      element.scrollHeight > element.clientHeight + 2 &&
      /auto|scroll/.test(css.overflowY);
    if (
      !element.id &&
      !scrollable &&
      !/^(MAIN|ARTICLE|SECTION)$/.test(element.tagName) &&
      !element.hasAttribute("role")
    )
      continue;
    const heading = element
      .querySelector("h1,h2,h3,[role=heading]")
      ?.textContent?.trim();
    let selector = element.id
      ? "#" + CSS.escape(element.id)
      : element.tagName.toLowerCase() +
        (element.getAttribute("role")
          ? '[role="' + CSS.escape(element.getAttribute("role")!) + '"]'
          : "");
    if (count(selector) !== 1) {
      let parent: Element | null = element;
      const segments: string[] = [];
      while (parent) {
        const siblings = parent.parentElement
          ? Array.from(parent.parentElement.children).filter(
              (child) => child.tagName === parent!.tagName,
            )
          : [parent];
        segments.unshift(
          parent.tagName.toLowerCase() +
            ":nth-of-type(" +
            (siblings.indexOf(parent) + 1) +
            ")",
        );
        const path = segments.join(" > ");
        if (count(path) === 1) {
          selector = path;
          break;
        }
        parent = parent.parentElement;
      }
    }
    if (emitted.has(selector)) continue;
    emitted.add(selector);
    output.push({
      selector,
      matches: count(selector),
      unique: count(selector) === 1,
      label: (
        element.getAttribute("aria-label") ||
        heading ||
        element.id ||
        element.tagName
      ).slice(0, 120),
      visible:
        rect.bottom > 0 &&
        rect.top < innerHeight &&
        rect.right > 0 &&
        rect.left < innerWidth,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      scrollable,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
    });
    if (output.length >= 40) break;
  }
  return output;
}

export function browserRegions(wc: WebContents) {
  return browserDeadline(wc.executeJavaScriptInIsolatedWorld(1001, [
    {
      code:
        "(" +
        inspectRegions.toString() +
        ")(" +
        findBrowserElements.toString() +
        ")",
    },
  ]), 10000, "read page regions");
}

export async function browserTargetNode(
  wc: WebContents,
  target: BrowserTarget,
) {
  const send = (method: string, params: Record<string, unknown> = {},sessionId?:string) =>
    browserCommand(wc, method, params,15000,sessionId);
  const rootTree=await send("Page.getFrameTree");
  const frames:{id:string;sessionId?:string;parentSessionId?:string}[]=target.frame === undefined ? [{id:rootTree.frameTree.frame.id}] : await browserFrameProtocol(wc).frames();
  let selected=target.mainOnly ? frames.slice(0,1) : frames;
  if(target.frame !== undefined) {
    if(typeof target.frame === "number") {
      if(!Number.isInteger(target.frame))throw new BrowserToolError("INVALID_TARGET","frame index must be an integer.");
      const children=frames.slice(1),frame=children[target.frame<0?children.length+target.frame:target.frame];selected=frame?[frame]:[];
    } else {
      const owner=await browserTargetNode(wc,{selector:target.frame,mainOnly:true});
      selected=[];
      for(const frame of frames.slice(1)) {
        const node=await send("DOM.getFrameOwner",{frameId:frame.id},frame.parentSessionId).catch(()=>undefined);
        if(node?.backendNodeId === owner)selected.push(frame);
      }
    }
    if(!selected.length)throw new BrowserToolError("FRAME_NOT_FOUND","No iframe matches the requested frame.",{frame:target.frame});
  }
  const found:number[]=[],distances:number[]=[],candidates:any[]=[];
  let hidden=0,unavailable=0;
  for(const frame of selected) {
    const world=await send("Page.createIsolatedWorld",{frameId:frame.id,worldName:"nautilo-browser-locators"},frame.sessionId).catch(()=>undefined);
    if(!world?.executionContextId){unavailable++;continue;}
    const expression=`(() => {
      const matches=(${findBrowserElements.toString()})(${JSON.stringify(target)});
      const visible=matches.filter(element=>{
        if(${!!target.allowHidden})return true;
        if(!element.getClientRects().length || getComputedStyle(element).visibility!=='visible')return false;
        let parent=element;while(parent){const css=getComputedStyle(parent);if(css.display==='none'||Number(css.opacity)===0)return false;parent=parent.parentElement??parent.getRootNode().host;}return true;
      });
      visible.hiddenMatches=matches.length-visible.length;
      return visible;
    })()`;
    const {result,exceptionDetails}=await send("Runtime.evaluate",{expression,contextId:world.executionContextId},frame.sessionId);
    if(exceptionDetails)throw new BrowserToolError("invalid_selector","The selector could not be evaluated.",{target},"Use a valid locator.",false);
    if(!result.objectId)continue;
    try {
      const metadata=await send("Runtime.callFunctionOn",{objectId:result.objectId,functionDeclaration:"function(){return {hidden:this.hiddenMatches,distances:this.map(n=>{const r=n.getBoundingClientRect();return Math.hypot(Math.max(0,-r.bottom,r.top-innerHeight),Math.max(0,-r.right,r.left-innerWidth));}),candidates:this.slice(0,5).map(n=>({tag:n.tagName,text:(n.textContent||'').trim().slice(0,100)}))}}",returnByValue:true});
      hidden+=metadata.result.value.hidden??0;candidates.push(...metadata.result.value.candidates);
      const {result:items}=await send("Runtime.getProperties",{objectId:result.objectId,ownProperties:true});
      for(const item of items)if(/^\d+$/.test(item.name) && item.value?.subtype === "node") {
        try {const {node}=await send("DOM.describeNode",{objectId:item.value.objectId});found.push(node.backendNodeId);distances.push(metadata.result.value.distances[Number(item.name)]);}
        finally {await send("Runtime.releaseObject",{objectId:item.value.objectId}).catch(()=>{});}
      }
    } finally {await send("Runtime.releaseObject",{objectId:result.objectId}).catch(()=>{});}
    if(frame.id === frames[0].id && target.frame === undefined && !target.mainOnly) {
      if(found.length)break;
      selected.push(...(await browserFrameProtocol(wc).frames()).filter(child=>child.id !== frame.id));
    }
  }
  const nth=target.nth;
  if(nth !== undefined && !Number.isInteger(nth))throw new BrowserToolError("INVALID_TARGET","nth must be an integer.");
  const chosen=nth === undefined ? target.selection === "nearest" ? found[distances.indexOf(Math.min(...distances))] : found.length===1 ? found[0] : undefined : found[nth<0?found.length+nth:nth];
  if(chosen !== undefined)return chosen;
  if(!found.length && unavailable && target.frame !== undefined)throw new BrowserToolError("FRAME_UNAVAILABLE","The selected frame is not available for page inspection.",{frame:target.frame},"Inspect the current iframe state before retrying.");
  throw new BrowserToolError(found.length && nth===undefined?"ambiguous_target":hidden?"TARGET_HIDDEN":"target_not_found",
    found.length?"Several elements match. Use a frame selector, nth or a more specific target.":"No visible element matches.",
    {target,matches:found.length,hiddenMatches:hidden,candidates:candidates.slice(0,5)},hidden?"Matching elements are hidden; choose a visible control.":"Read a fresh snapshot and inspect the frame and locator.");
}
