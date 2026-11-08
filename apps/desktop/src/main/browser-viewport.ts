import type { WebContents, WebFrameMain } from "electron";
import { findBrowserElements } from "./browser-dom";
import { BrowserToolError, browserDeadline } from "./browser-errors";

export type BrowserReadOptions = {
  text?: string;
  offset?: number;
  scope?: "viewport" | "document" | "main";
  selector?: string;
  limit?: number;
  jsonPath?: string;
};

type Clip = { left: number; top: number; right: number; bottom: number };
type EmbeddedFrame = { frame: number; url: string; name: string; clip: Clip };
type ReadOptions = {
  document: boolean;
  offset: number;
  limit: number;
  filter: string;
  main: boolean;
  selector?: string;
  clip?: Clip;
};
type FrameText = {
  text: string;
  length: number;
  frames: EmbeddedFrame[];
  width: number;
  height: number;
  scrollY: number;
  pageHeight: number;
  devicePixelRatio: number;
  matchedRegions: number;
  loadingHints: string[];
  visibleRegions: number;
  fields: {
    tag: string;
    type: string;
    value?: string;
    redacted?: boolean;
    checked?: boolean;
    selectedValues?: string[];
  }[];
};

// Runs inside each document. Only visit text that the renderer laid out inside
// the viewport, including slotted content and nested scrolling regions.
function readFrame(
  options: ReadOptions,
  locate: typeof findBrowserElements,
): FrameText {
  const lines: string[] = [];
  const frames: EmbeddedFrame[] = [];
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const intersect = (a: Clip, b: Clip): Clip => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });
  const visible = (r: Clip) => r.right > r.left && r.bottom > r.top;
  const range = document.createRange();
  const fields: FrameText["fields"] = [];
  function visit(node: Node, clip: Clip) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (!text?.trim()) return;
      range.selectNodeContents(node);
      const rects = range.getClientRects();
      if (
        options.document
          ? rects.length > 0
          : Array.from(rects).some((r) => visible(intersect(clip, r)))
      )
        lines.push(text);
      return;
    }
    if (
      !(node instanceof Element) ||
      /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(node.tagName) ||
      node.hasAttribute("data-nautilo-pointer")
    )
      return;
    if (
      options.main &&
      node.matches(
        "nav,footer,aside,[role=navigation],[role=banner],[role=contentinfo],[role=complementary]",
      )
    )
      return;
    const css = getComputedStyle(node);
    if (
      css.display === "none" ||
      css.contentVisibility === "hidden" ||
      Number(css.opacity) === 0
    )
      return;
    const bounds = node.getBoundingClientRect();
    if (
      (options.document || visible(intersect(clip, bounds))) &&
      css.visibility === "visible"
    ) {
      if (
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement ||
        node instanceof HTMLSelectElement
      ) {
        const type =
          node instanceof HTMLInputElement
            ? node.type
            : node.tagName.toLowerCase();
        const redacted =
          type === "password" || type === "hidden" || type === "file";
        fields.push({
          tag: node.tagName.toLowerCase(),
          type,
          value: redacted ? undefined : node.value,
          redacted: redacted || undefined,
          checked:
            node instanceof HTMLInputElement &&
            ["checkbox", "radio"].includes(type)
              ? node.checked
              : undefined,
          selectedValues:
            node instanceof HTMLSelectElement
              ? Array.from(node.selectedOptions).map((option) => option.value)
              : undefined,
        });
      }
    }
    if (node instanceof HTMLIFrameElement || node instanceof HTMLFrameElement) {
      const area = intersect(clip, bounds);
      if ((!options.document && !visible(area)) || css.visibility !== "visible")
        return;
      const idx = Array.prototype.indexOf.call(
        window.frames,
        node.contentWindow,
      );
      frames.push({
        frame: idx,
        url: node.src,
        name: node.name,
        clip: {
          left: area.left - bounds.left,
          top: area.top - bounds.top,
          right: area.right - bounds.left,
          bottom: area.bottom - bounds.top,
        },
      });
      return;
    }
    if (
      !options.document &&
      node !== document.body &&
      node !== document.documentElement &&
      css.display !== "contents"
    ) {
      if (css.overflowX !== "visible")
        clip = {
          ...clip,
          left: Math.max(clip.left, bounds.left),
          right: Math.min(clip.right, bounds.right),
        };
      if (css.overflowY !== "visible")
        clip = {
          ...clip,
          top: Math.max(clip.top, bounds.top),
          bottom: Math.min(clip.bottom, bounds.bottom),
        };
      if (!visible(clip)) return;
    }
    const children = node.shadowRoot
      ? node.shadowRoot.childNodes
      : node instanceof HTMLSlotElement && node.assignedNodes().length
        ? node.assignedNodes({ flatten: true })
        : node.childNodes;
    for (const child of Array.from(children)) {
      if (child.nodeType !== Node.TEXT_NODE || css.visibility === "visible")
        visit(child, clip);
    }
  }
  let regions: Element[] = document.body ? [document.body] : [];
  if (options.selector) regions = locate({ selector: options.selector });
  else if (options.main) {
    const candidates = locate({ selector: "main,article,[role=main]" });
    const best = candidates.sort(
      (a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0),
    )[0];
    if (best) regions = [best];
  }
  const selectedRegions = regions.filter(
    (region) =>
      !regions.some((parent) => parent !== region && parent.contains(region)),
  );
  for (const region of selectedRegions)
    visit(region, options.clip ? intersect(viewport, options.clip) : viewport);

  const matched = new Set<number>();
  if (options.filter)
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(options.filter)) {
        for (let j = Math.max(0, i - 2); j < Math.min(lines.length, i + 6); j++)
          matched.add(j);
      }
    });
  // Slice inside the page. A single large JSON text node must be resumable
  // without transferring the entire document on each call.
  let text = "",
    length = 0;
  function append(part: string) {
    const from = Math.max(0, options.offset - length);
    const to = Math.min(part.length, options.offset + options.limit - length);
    if (from < to) text += part.slice(from, to);
    length += part.length;
  }
  lines.forEach((line, i) => {
    if (options.filter && !matched.has(i)) return;
    if (options.filter && line.length > 4000) {
      // A matching property may be deep inside a single-line JSON response.
      const lower = line.toLowerCase();
      let match = lower.indexOf(options.filter);
      if (match < 0) return;
      while (match >= 0) {
        const end = Math.min(line.length, match + options.filter.length + 600);
        append(line.slice(Math.max(0, match - 200), end));
        append("\n");
        match = lower.indexOf(options.filter, end);
      }
    } else {
      append(line);
      append("\n");
    }
  });
  return {
    text,
    length,
    frames,
    width: innerWidth,
    height: innerHeight,
    scrollY,
    pageHeight: document.scrollingElement?.scrollHeight ?? innerHeight,
    devicePixelRatio,
    matchedRegions: selectedRegions.length,
    visibleRegions: selectedRegions.filter(
      (region) =>
        visible(intersect(viewport, region.getBoundingClientRect())) &&
        getComputedStyle(region).visibility === "visible" &&
        region.getClientRects().length,
    ).length,
    fields,
    loadingHints: lines
      .filter((line) => /loading|正在.{0,6}加载|加载中/i.test(line))
      .slice(0, 5)
      .map((line) => line.trim().slice(0, 200)),
  };
}

export async function readBrowserViewport(
  wc: WebContents,
  args: BrowserReadOptions = {},
) {
  const tabUrl = wc.getURL();
  const offset = args.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw Error("Invalid text offset");
  if (
    args.scope !== undefined &&
    !["viewport", "document", "main"].includes(args.scope)
  )
    throw Error("Unknown text scope");
  const filter =
    typeof args.text === "string" ? args.text.trim().toLowerCase() : "";
  const document = args.scope === "document" || args.scope === "main";
  const limit = args.limit ?? 16000;
  if (!Number.isInteger(limit) || limit < 256 || limit > 24000)
    throw new BrowserToolError(
      "invalid_limit",
      "Read limit must be between 256 and 24000 characters.",
      {},
      undefined,
      false,
    );
  let visited = 0,
    unreadFrames = 0,
    length = 0,
    text = "";
  const fields: FrameText["fields"] = [];
  async function collect(frame: WebFrameMain, clip?: Clip): Promise<FrameText> {
    visited++;
    const options: ReadOptions = {
      document,
      main: args.scope === "main",
      selector: args.selector,
      filter,
      offset: Math.max(0, offset - length),
      limit: limit - text.length,
      clip,
    };
    const script =
      "(" +
      readFrame.toString() +
      ")(" +
      JSON.stringify(options) +
      "," +
      findBrowserElements.toString() +
      ")";
    const result: FrameText =
      frame === wc.mainFrame
        ? await browserDeadline(
            wc.executeJavaScriptInIsolatedWorld(1001, [{ code: script }]),
            5000,
            "read document text",
          )
        : await browserDeadline(
            frame.executeJavaScript(script),
            5000,
            "read embedded frame text",
          );
    length += result.length;
    text += result.text;
    fields.push(...result.fields);
    const children = frame.frames;
    const remaining = new Set(children);
    for (const item of result.frames) {
      // Window.frames can omit frames inside shadow roots.
      const child =
        children[item.frame] ??
        [...remaining].find(
          (c) => (item.name && c.name === item.name) || c.url === item.url,
        );
      if (!child || !remaining.delete(child) || visited >= 48) {
        unreadFrames++;
        continue;
      }
      await collect(child, item.clip).catch(() => {
        unreadFrames++;
      });
    }
    return result;
  }
  const {
    width,
    height,
    scrollY,
    pageHeight,
    devicePixelRatio,
    matchedRegions,
    loadingHints,
    visibleRegions,
  } = await collect(wc.mainFrame);
  if (wc.getURL() !== tabUrl)
    throw new BrowserToolError(
      "page_navigated",
      "The tab navigated during the read.",
      { urlBefore: tabUrl, urlAfter: wc.getURL() },
      "Read the current page again.",
    );
  const end = offset + text.length;
  return {
    url: tabUrl,
    title: wc.getTitle(),
    scope: args.scope ?? "viewport",
    width,
    height,
    scrollY,
    pageHeight,
    devicePixelRatio,
    coordinateUnit: "css-pixels",
    matchedRegions,
    visibleRegions,
    fields: fields.length ? fields : undefined,
    text,
    totalCharacters: length,
    nextOffset: end < length ? end : undefined,
    outOfRange: offset > length,
    rangeHint: offset > length ? "offset exceeds document length" : undefined,
    hasMoreBelow: scrollY + height < pageHeight - 1,
    loadingHints: loadingHints.length ? loadingHints : undefined,
    hint: loadingHints.length
      ? "Loading placeholders are present. Scroll the relevant region into view, then wait and read again."
      : undefined,
    unreadFrames: unreadFrames || undefined,
  };
}
