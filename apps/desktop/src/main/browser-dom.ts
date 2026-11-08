import type { WebContents } from "electron";
import { BrowserToolError } from "./browser-errors";
import { browserCommand } from "./browser-protocol";

export type BrowserTarget = {
  selector?: string;
  text?: string;
  exact?: boolean;
  selection?: "nearest";
  within?: string;
};

// Serialized into an isolated browser world. Keep this function self-contained.
export function findBrowserElements(target: BrowserTarget): Element[] {
  const matches: Element[] = [];
  const roots: (Document | ShadowRoot)[] = [document];
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const wanted = normalize(target.text ?? "");
  const textMatches = (value: string) =>
    target.exact === false
      ? normalize(value).includes(wanted)
      : normalize(value) === wanted;
  for (const root of roots) {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
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
      if (target.selector) {
        if (element.matches(target.selector)) matches.push(element);
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
  return wc.executeJavaScriptInIsolatedWorld(1001, [
    {
      code:
        "(" +
        inspectRegions.toString() +
        ")(" +
        findBrowserElements.toString() +
        ")",
    },
  ]);
}

export async function browserTargetNode(
  wc: WebContents,
  target: BrowserTarget,
) {
  const send = (method: string, params: Record<string, unknown> = {}) =>
    browserCommand(wc, method, params);
  const { frameTree } = await send("Page.getFrameTree");
  const { executionContextId } = await send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "nautilo-browser-locators",
  });
  const expression = `(() => {
    const matches = (${findBrowserElements.toString()})(${JSON.stringify(target)});
    const visible = matches.filter(element => {
      if(!element.getClientRects().length)return false;
      if(getComputedStyle(element).visibility!=='visible')return false;
      let parent=element;
      while(parent){
        const css=getComputedStyle(parent);
        if(css.display==='none'||Number(css.opacity)===0)return false;
        parent=parent.parentElement ?? parent.getRootNode().host;
      }
      return true;
    });
    const distance=element=>{
      const rect=element.getBoundingClientRect();
      return Math.hypot(Math.max(0,-rect.bottom,rect.top-innerHeight),Math.max(0,-rect.right,rect.left-innerWidth));
    };
    if(${JSON.stringify(target.selection)}==='nearest' && visible.length) return visible.sort((a,b)=>distance(a)-distance(b))[0];
    if (visible.length !== 1) return {matches:visible.length,hiddenMatches:matches.length-visible.length,totalMatches:matches.length};
    return visible[0];
  })()`;
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression,
    contextId: executionContextId,
  });
  if (exceptionDetails)
    throw new BrowserToolError(
      "invalid_selector",
      "The selector could not be evaluated.",
      { target },
      "Use a valid CSS selector.",
      false,
    );
  const objectId: string | undefined = result.objectId;
  if (!objectId)
    throw new BrowserToolError("target_not_found", "No matching element.", {
      target,
    });
  try {
    if (result.subtype !== "node") {
      const { result: value } = await send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(){return this}",
        returnByValue: true,
      });
      throw new BrowserToolError(
        value.value.matches ? "ambiguous_target" : "target_not_found",
        value.value.matches
          ? "Several elements match. Use a more specific selector."
          : "No visible element matches.",
        { target, ...value.value },
        "Inspect the page or choose a unique selector.",
      );
    }
    const { node } = await send("DOM.describeNode", { objectId });
    return node.backendNodeId as number;
  } finally {
    await browserCommand(wc, "Runtime.releaseObject", { objectId }, 1000).catch(
      () => {},
    );
  }
}
