import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { showBrowserPointer } from "./browser-pointer";
import { browserCommand, settleBrowserLayout } from "./browser-protocol";
import {
  readBrowserViewport,
  type BrowserReadOptions,
} from "./browser-viewport";
import { browserTargetNode } from "./browser-dom";
import {
  BrowserToolError,
  browserError,
  browserDeadline,
} from "./browser-errors";

type AXNode = {
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string | number | boolean };
  properties?: { name: string; value?: { value?: unknown } }[];
  nodeId?: string;
  parentId?: string;
};
export type BrowserStep = {
  action: string;
  url?: string;
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
  key?: string;
  deltaX?: number;
  deltaY?: number;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  modifiers?: string[];
  button?: "left" | "middle" | "right";
  clickCount?: number;
  timeoutMs?: number;
  selector?: string;
  scope?: "viewport" | "document" | "main";
  offset?: number;
  limit?: number;
  jsonPath?: string;
  alsoTryScroll?: boolean;
  factor?: number;
  urlIncludes?: string;
  visible?: boolean;
  waitUntil?: "domcontentloaded" | "load";
};
type Step = BrowserStep;

export type BrowserStepReport = {
  step: number;
  action: string;
  status: "running" | "completed" | "failed" | "interrupted";
  urlBefore: string;
  urlAfter?: string;
  documentChanged?: boolean;
  result?: unknown;
};

export function webUrl(input: unknown): string {
  if (typeof input !== "string") throw Error("Expected an HTTP or HTTPS URL");
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("Only HTTP and HTTPS pages are supported");
  return url.href;
}

const controlRoles = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "option",
  "tab",
  "menuitem",
  "slider",
  "spinbutton",
  "listbox",
  "treeitem",
]);
const contentRoles = new Set([
  "heading",
  "StaticText",
  "alert",
  "status",
  "cell",
  "columnheader",
  "rowheader",
  "img",
]);

/** One driver per page. Refs identify backend nodes in exactly one document. */
export class BrowserActions {
  private epoch = 1;
  private readonly refScope = randomUUID();
  private paintedEpoch = 0;
  private pointerReadyAt = 0;
  private jsonResponse?: { epoch: number; body?: string; error?: string };

  surfaceChanged() {
    // Chromium on Windows can drop button presses immediately after a new
    // document or native view is presented, although mouse moves are delivered.
    if (process.platform === "win32")
      this.pointerReadyAt = performance.now() + 900;
  }

  private async waitForPointer(check: () => void) {
    const delay = this.pointerReadyAt - performance.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    check();
  }
  private refs = new Map<string, number>();

  constructor(
    private readonly page: WebContents,
    private readonly tabId = String(page.id),
  ) {
    this.surfaceChanged();
    page.on("dom-ready", () => this.surfaceChanged());
    page.on("did-start-navigation", (_event, _url, inPage, main) => {
      if (main && !inPage) this.invalidate();
    });
    page.on("render-process-gone", () => this.invalidate());
    page.debugger.on("detach", () => this.invalidate());
  }

  private async jsonResource() {
    if (
      this.jsonResponse?.epoch === this.epoch &&
      this.jsonResponse.body !== undefined
    )
      return this.jsonResponse;
    const type = await browserDeadline(
      this.page.executeJavaScriptInIsolatedWorld(1001, [
        { code: "document.contentType" },
      ]),
      5000,
      "document content type",
    );
    if (!/(?:application|text)\/(?:[\w.-]+\+)?json(?:;|$)/i.test(type))
      return undefined;
    const response: { epoch: number; body?: string; error?: string } = {
      epoch: this.epoch,
    };
    const url = this.page.getURL();
    try {
      await browserCommand(this.page, "Page.enable", {}, 5000);
      const { frameTree } = await browserCommand(
        this.page,
        "Page.getFrameTree",
        {},
        5000,
      );
      const resource = await browserCommand(
        this.page,
        "Page.getResourceContent",
        {
          frameId: frameTree.frame.id,
          url: url.split("#")[0],
        },
        5000,
      );
      response.body = resource.base64Encoded
        ? Buffer.from(resource.content, "base64").toString("utf8")
        : resource.content;
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error);
    }
    if (this.epoch !== response.epoch || this.page.getURL() !== url)
      throw new BrowserToolError(
        "page_navigated",
        "The tab navigated while reading its response.",
        {},
        "Read the current tab again.",
      );
    this.jsonResponse = response;
    return response;
  }

  private invalidate(): void {
    this.epoch++;
    this.refs.clear();
    this.jsonResponse = undefined;
  }

  async read(args: BrowserReadOptions = {}) {
    if (args.jsonPath && args.selector)
      throw new BrowserToolError(
        "invalid_read_options",
        "Choose a JSON path or a DOM selector for this read.",
        {},
        undefined,
        false,
      );
    if (!this.page.getURL()) await this.page.loadURL("about:blank");
    const response = args.selector ? undefined : await this.jsonResource();
    if (
      response?.body !== undefined &&
      response.epoch === this.epoch &&
      !args.selector
    ) {
      let content = response.body;
      if (args.jsonPath) {
        const path = args.jsonPath;
        if (!/^\$(?:\.[\w-]+|\[\d+\])*$/.test(path))
          throw new BrowserToolError(
            "invalid_json_path",
            "Use a JSON path such as $.data.replies[0].",
            {},
            undefined,
            false,
          );
        let value: unknown = JSON.parse(content);
        for (const match of path.matchAll(/\.([\w-]+)|\[(\d+)\]/g)) {
          const key = match[1] ?? match[2];
          if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
            throw new BrowserToolError(
              "json_path_not_found",
              "The JSON path is absent.",
              { path },
              undefined,
              false,
            );
          value = (value as Record<string, unknown>)[key];
        }
        content = JSON.stringify(value, null, 2);
      }
      const offset = args.offset ?? 0,
        limit = args.limit ?? 16000;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 256 ||
        limit > 24000
      )
        throw new BrowserToolError(
          "invalid_read_range",
          "Invalid read offset or limit.",
          {},
          undefined,
          false,
        );
      if (args.text) {
        const index = content.toLowerCase().indexOf(args.text.toLowerCase());
        content =
          index < 0
            ? ""
            : content.slice(
                Math.max(0, index - 200),
                index + args.text.length + 600,
              );
      }
      const metrics = await this.viewport();
      const text = content.slice(offset, offset + limit),
        end = offset + text.length;
      return {
        url: this.page.getURL(),
        title: this.page.getTitle(),
        format: "json",
        source: "loaded-main-response",
        scope: args.scope ?? "document",
        ...metrics,
        text,
        totalCharacters: content.length,
        outOfRange: offset > content.length,
        rangeHint:
          offset > content.length
            ? "offset exceeds document length"
            : undefined,
        nextOffset: end < content.length ? end : undefined,
        continueWith:
          end < content.length
            ? {
                tool: "browser_read",
                arguments: {
                  ...args,
                  tabId: this.tabId,
                  offset: end,
                },
              }
            : undefined,
        documentVersion: this.epoch,
      };
    }
    if (args.jsonPath)
      throw new BrowserToolError(
        "json_response_unavailable",
        "The current tab has no available original JSON response.",
        { reason: response?.error },
        "Read the rendered document, or open the intended JSON page before using jsonPath.",
      );
    const result = await readBrowserViewport(this.page, args);
    return {
      ...result,
      source: "rendered-document",
      rawResponseError: response?.error,
      continueWith:
        result.nextOffset !== undefined
          ? {
              tool: "browser_read",
              arguments: {
                ...args,
                tabId: this.tabId,
                offset: result.nextOffset,
              },
            }
          : undefined,
      documentVersion: this.epoch,
    };
  }

  async viewport() {
    return browserDeadline(
      this.page.executeJavaScriptInIsolatedWorld(1001, [
        {
          code: "({width:innerWidth,height:innerHeight,devicePixelRatio,scrollX,scrollY,pageHeight:document.scrollingElement?.scrollHeight??innerHeight,coordinateUnit:'css-pixels'})",
        },
      ]),
      5000,
      "viewport metrics",
    );
  }

  private async navigate(
    url: string,
    check: () => void,
    waitUntil: "domcontentloaded" | "load",
    timeoutMs: number,
  ) {
    // A slow image or analytics request should not hold up a usable document.
    const wc = this.page;
    return new Promise<void>((resolve, reject) => {
      const started = Date.now();
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        if (waitUntil === "load") wc.removeListener("did-finish-load", ready);
        else wc.removeListener("dom-ready", ready);
        if (error) reject(error);
        else resolve();
      };
      const ready = () => {
        try {
          check();
          finish();
        } catch (error) {
          finish(error);
        }
      };
      const timer = setInterval(() => {
        try {
          check();
          if (Date.now() - started >= timeoutMs) {
            wc.stop();
            throw new BrowserToolError(
              "navigation_timeout",
              "The page did not reach the requested loading state in time.",
              { url, waitUntil, timeoutMs },
              "Inspect the current page before retrying. For pages with slow subresources, use waitUntil:domcontentloaded and wait for a specific target.",
            );
          }
        } catch (error) {
          finish(error);
        }
      }, 100);
      if (waitUntil === "load") wc.once("did-finish-load", ready);
      else wc.once("dom-ready", ready);
      wc.loadURL(url).then(ready, finish);
    });
  }

  async run(
    input: { steps?: unknown; snapshot?: boolean },
    check: () => void,
    waitForControl?: (timeout: number) => Promise<void>,
    openLink?: (
      url: string,
      background: boolean,
    ) => Promise<{ tabId: string; url: string }>,
  ) {
    const steps = input?.steps;
    if (!Array.isArray(steps) || steps.length > 30)
      throw Error("Provide up to 30 steps");
    if (!this.page.getURL() && steps[0]?.action !== "open")
      await this.page.loadURL("about:blank");
    const cleanup = (method: string, params: Record<string, unknown>) =>
      browserCommand(this.page, method, params, 1000);
    const send = async (
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      check();
      return browserCommand(this.page, method, params);
    };
    const scan = async (): Promise<AXNode[]> =>
      (await send("Accessibility.getFullAXTree")).nodes;
    const render = (nodes: AXNode[], filter?: string, compact = false) => {
      const lines: string[] = [];
      const byId = new Map(
        nodes
          .filter((node) => node.nodeId !== undefined)
          .map((node) => [node.nodeId, node]),
      );
      let length = 0;
      let shortened = false;
      for (const n of nodes) {
        const role = String(n.role?.value ?? ""),
          name = String(n.name?.value ?? "")
            .trim()
            .replace(/\s+/g, " ");
        if (
          n.ignored ||
          (!controlRoles.has(role) && (!name || !contentRoles.has(role)))
        )
          continue;
        if (compact && !controlRoles.has(role) && role !== "heading") continue;
        if (compact && role === "link") {
          let parent = byId.get(n.parentId);
          let navigation = false;
          const ancestors = new Set<string | undefined>();
          while (parent && !ancestors.has(parent.nodeId)) {
            ancestors.add(parent.nodeId);
            if (
              ["navigation", "banner", "contentinfo", "complementary"].includes(
                parent.role?.value ?? "",
              )
            ) {
              navigation = true;
              break;
            }
            parent = byId.get(parent.parentId);
          }
          if (navigation) continue;
        }
        if (filter && !name.toLowerCase().includes(filter.toLowerCase()))
          continue;
        let ref = "";
        if (n.backendDOMNodeId && controlRoles.has(role)) {
          ref =
            "@" + this.refScope + "." + this.epoch + "." + n.backendDOMNodeId;
          this.refs.set(ref, n.backendDOMNodeId);
        }
        if (name.length > 480) shortened = true;
        const label = name.length > 480 ? name.slice(0, 480) + "…" : name;
        const protectedValue = n.properties?.some(
          (property) => property.name === "protected" && property.value?.value,
        );
        const value =
          controlRoles.has(role) && n.value?.value !== undefined
            ? protectedValue
              ? "[redacted]"
              : String(n.value.value)
            : undefined;
        if (value && value.length > 480) shortened = true;
        const line = [
          ref,
          role,
          label,
          value === undefined
            ? ""
            : "value=" + JSON.stringify(value.slice(0, 480)),
        ]
          .filter(Boolean)
          .join(" ");
        if (
          length + line.length > (compact ? 6000 : 12000) ||
          lines.length >= (compact ? 60 : 140)
        ) {
          shortened = true;
          break;
        }
        if (role === "StaticText" && lines.at(-1)?.endsWith(" " + name))
          continue;
        lines.push(line);
        length += line.length;
      }
      if (shortened)
        lines.push(
          "[Snapshot shortened. Use browser_read with scope=document and follow nextOffset for full loaded text.]",
        );
      return lines.join("\n");
    };
    const nodeId = async (s: Step) => {
      if (s.ref) {
        const id = this.refs.get(s.ref);
        if (!id)
          throw new BrowserToolError(
            "stale_ref",
            "Stale or unknown ref. Read a new snapshot.",
            { ref: s.ref, documentVersion: this.epoch },
            "Use the returned fresh snapshot and retry only the remaining steps.",
          );
        return id;
      }
      if (s.selector || (s.text && !s.role))
        return browserTargetNode(this.page, {
          selector: s.selector,
          text: s.text,
        });
      if (!s.role || typeof s.name !== "string")
        throw Error("Use a ref or an exact role and name");
      const matches = (await scan()).filter(
        (n) =>
          !n.ignored &&
          n.role?.value === s.role &&
          String(n.name?.value || "").trim() === s.name,
      );
      if (matches.length !== 1 || !matches[0].backendDOMNodeId)
        throw new BrowserToolError(
          matches.length ? "ambiguous_target" : "target_not_found",
          "Target missing or ambiguous. Read a new snapshot.",
          { target: { role: s.role, name: s.name }, matches: matches.length },
          "Read a fresh snapshot and choose an available unique target.",
        );
      return matches[0].backendDOMNodeId;
    };
    const modifierMask = (names: Step["modifiers"]) => {
      const flags: Record<string, number> = {
        Alt: 1,
        Control: 2,
        Meta: 4,
        Shift: 8,
      };
      if (names === undefined) return 0;
      if (
        !Array.isArray(names) ||
        names.some((name) => !Object.hasOwn(flags, name))
      )
        throw Error("Unknown modifier key");
      return names.reduce((mask, name) => mask | flags[name], 0);
    };
    const viewportPoint = async (x: unknown, y: unknown) => {
      const { cssVisualViewport: bounds } = await send("Page.getLayoutMetrics");
      if (
        typeof x !== "number" ||
        typeof y !== "number" ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= bounds.clientWidth ||
        y >= bounds.clientHeight
      )
        throw new BrowserToolError(
          "point_outside_viewport",
          "Point is outside the tab viewport",
          { x, y, viewport: bounds },
          "Use CSS coordinates from the current screenshot or browser_state.",
          false,
        );
      return { x, y };
    };
    const pointer = async (
      step: Step,
      point: { x: number; y: number },
      objectId?: string,
    ) => {
      const modifiers = modifierMask(step.modifiers);
      await showBrowserPointer(
        this.page,
        point.x,
        point.y,
        step.action === "hover" ? "move" : "click",
      );
      if (step.action === "hover") {
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...point,
          modifiers,
        });
        return { point, inputDelivered: true };
      }
      await this.waitForPointer(check);
      const button = step.button ?? "left";
      const count = step.clickCount ?? 1;
      if (
        ![1, 2].includes(count) ||
        !["left", "middle", "right"].includes(button)
      )
        throw Error("Invalid mouse button or click count");
      const version = this.epoch;
      let observation: string | undefined;
      if (objectId) {
        const { result } = await send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration:
            "function(){const target=this,state={received:false};const listener=event=>{if(event.composedPath().includes(target))state.received=true};window.addEventListener('mousedown',listener,true);state.dispose=()=>window.removeEventListener('mousedown',listener,true);return state}",
        });
        observation = result.objectId;
      }
      try {
        for (let clickCount = 1; clickCount <= count; clickCount++) {
          await send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            ...point,
            modifiers,
          });
          await send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            ...point,
            button,
            modifiers,
            clickCount,
            buttons: { left: 1, right: 2, middle: 4 }[button],
          });
          try {
            await send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              ...point,
              button,
              modifiers,
              clickCount,
              buttons: 0,
            });
          } catch (error) {
            await cleanup("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              ...point,
              button,
              modifiers,
              clickCount,
              buttons: 0,
            }).catch(() => {});
            throw error;
          }
        }
        if (
          observation &&
          this.epoch === version &&
          !this.page.isLoadingMainFrame()
        ) {
          const { result } = await send("Runtime.callFunctionOn", {
            objectId: observation,
            functionDeclaration: "function(){return this.received}",
            returnByValue: true,
          });
          if (!result.value)
            throw new BrowserToolError(
              "input_not_delivered",
              "The page did not receive the click on the requested target.",
              {
                target: {
                  selector: step.selector,
                  ref: step.ref,
                  text: step.text,
                },
                point,
              },
              "Inspect the current page before retrying this step. A moving layout or overlay may have intercepted it.",
            );
        }
        return { point, inputDelivered: true };
      } finally {
        if (observation) {
          await cleanup("Runtime.callFunctionOn", {
            objectId: observation,
            functionDeclaration: "function(){this.dispose()}",
          }).catch(() => {});
          await cleanup("Runtime.releaseObject", {
            objectId: observation,
          }).catch(() => {});
        }
      }
    };
    const modifiedLink = async (step: Step, objectId: string) => {
      if (
        !openLink ||
        step.action !== "click" ||
        (step.button ?? "left") !== "left" ||
        !(
          step.modifiers?.includes("Control") ||
          step.modifiers?.includes("Meta")
        )
      )
        return undefined;
      const { result } = await send("Runtime.callFunctionOn", {
        objectId,
        returnByValue: true,
        functionDeclaration:
          "function(){let node=this;while(node){if(node instanceof HTMLAnchorElement && node.href)return node.href;node=node.parentElement??node.getRootNode().host}return null}",
      });
      if (typeof result.value !== "string") return undefined;
      const url = webUrl(result.value),
        background = !step.modifiers?.includes("Shift");
      const opened = await openLink(url, background);
      return {
        openedTabId: opened.tabId,
        url: opened.url,
        opened: true,
        background,
        navigation: "new-tab",
      };
    };
    const reads: string[] = [];
    const readResults: unknown[] = [];
    let content: unknown;
    const reports: BrowserStepReport[] = [];
    let outputRemaining = 24000;
    const append = (text: string) => {
      const chunk = text.slice(0, outputRemaining);
      if (chunk) reads.push(chunk);
      if (chunk.length < text.length)
        reads.push(
          "[Output budget reached. Use browser_read to continue with nextOffset.]",
        );
      outputRemaining -= chunk.length;
    };
    let completed = 0;
    try {
      const actions = new Set([
        "open",
        "read",
        "click",
        "fill",
        "wait",
        "wait_for_control",
        "scroll",
        "scroll_into_view",
        "scroll_to_text",
        "hover",
        "drag",
        "press",
        "select",
        "back",
        "forward",
        "reload",
        "zoom",
      ]);
      for (const [index, step] of (steps as Step[]).entries()) {
        if (!step || typeof step !== "object" || !actions.has(step.action))
          throw new BrowserToolError(
            "invalid_step",
            "Unknown or invalid browser step.",
            { step: index + 1 },
            "Correct the batch before retrying.",
            false,
          );
        if (step.action === "open") {
          try {
            webUrl(step.url);
          } catch (error) {
            throw new BrowserToolError(
              "invalid_url",
              error instanceof Error ? error.message : String(error),
              { step: index + 1 },
              "Correct the URL before retrying the batch.",
              false,
            );
          }
        }
        if (
          step.waitUntil !== undefined &&
          !["domcontentloaded", "load"].includes(step.waitUntil)
        )
          throw new BrowserToolError(
            "invalid_wait_until",
            "waitUntil must be domcontentloaded or load.",
            { step: index + 1 },
            undefined,
            false,
          );
        if (step.visible !== undefined && typeof step.visible !== "boolean")
          throw new BrowserToolError(
            "invalid_visibility",
            "visible must be a boolean.",
            { step: index + 1 },
            undefined,
            false,
          );
        if (
          step.timeoutMs !== undefined &&
          (!Number.isInteger(step.timeoutMs) ||
            step.timeoutMs < 100 ||
            step.timeoutMs > 60000)
        )
          throw new BrowserToolError(
            "invalid_timeout",
            "Timeout must be between 100 and 60000 milliseconds.",
            { step: index + 1 },
            undefined,
            false,
          );
      }
      for (const step of steps as Step[]) {
        check();
        if (!step || typeof step !== "object") throw Error("Invalid step");
        const version = this.epoch;
        const report: BrowserStepReport = {
          step: completed + 1,
          action: step.action,
          status: "running",
          urlBefore: this.page.getURL(),
        };
        reports.push(report);
        // Reject a known invalid ref before any layout or protocol work.
        if (step.ref) await nodeId(step);
        if (
          this.paintedEpoch !== this.epoch &&
          [
            "drag",
            "click",
            "fill",
            "hover",
            "select",
            "scroll",
            "press",
          ].includes(step.action)
        ) {
          const epoch = this.epoch;
          await settleBrowserLayout(check);
          this.paintedEpoch = epoch;
        }
        switch (step.action) {
          case "open": {
            const waitUntil = step.waitUntil ?? "domcontentloaded";
            await this.navigate(
              webUrl(step.url),
              check,
              waitUntil,
              step.timeoutMs ?? 20000,
            );
            const { result } = await send("Runtime.evaluate", {
              expression: "document.readyState",
              returnByValue: true,
            });
            report.result = { waitUntil, readyState: result.value };
            break;
          }
          case "read": {
            if (outputRemaining < 256) {
              report.result = {
                scope: step.scope ?? "viewport",
                selector: step.selector,
                nextOffset: step.offset ?? 0,
                reason: "read_budget_exhausted",
                recovery:
                  "Continue with browser_read using the same tab, selector and offset.",
              };
              readResults.push(report.result);
              break;
            }
            const visible = await this.read({
              text: step.text,
              scope: step.scope,
              selector: step.selector,
              offset: step.offset,
              limit: Math.max(
                256,
                Math.min(outputRemaining, step.limit ?? 16000),
              ),
              jsonPath: step.jsonPath,
            });
            const { text, ...metadata } = visible;
            report.result = {
              ...metadata,
              textIndex: text ? reads.length : undefined,
            };
            readResults.push(report.result);
            if (visible.text) append(visible.text);
            if (!step.scope && !step.selector && !step.jsonPath)
              append(render(await scan(), step.text, true));
            break;
          }
          case "wait_for_control": {
            if (!waitForControl)
              throw new BrowserToolError(
                "control_wait_unavailable",
                "Control waiting is unavailable for this browser driver.",
              );
            await waitForControl(step.timeoutMs ?? 15000);
            report.result = { ready: true };
            break;
          }
          case "wait": {
            if (!step.text && !step.selector && !step.urlIncludes)
              throw Error("wait requires text, selector or urlIncludes");
            const deadline =
              Date.now() +
              Math.min(60000, Math.max(100, Number(step.timeoutMs) || 5000));
            let scrollAttempts = 0;
            while (true) {
              check();
              const matchesUrl =
                !step.urlIncludes ||
                this.page.getURL().includes(step.urlIncludes);
              if (step.urlIncludes && !step.text && !step.selector) {
                if (matchesUrl) {
                  report.result = { matched: true, url: this.page.getURL() };
                  break;
                }
                if (Date.now() >= deadline)
                  throw new BrowserToolError(
                    "wait_timeout",
                    "The URL did not reach the requested location.",
                    { url: this.page.getURL(), urlIncludes: step.urlIncludes },
                    "Inspect the page and the preceding click or form submission.",
                  );
                await new Promise((resolve) => setTimeout(resolve, 100));
                continue;
              }
              let visible;
              try {
                visible = await this.read({
                  text: step.text,
                  selector: step.selector,
                  scope: step.visible ? "viewport" : "document",
                });
              } catch (error) {
                if (
                  !this.page.isLoadingMainFrame() &&
                  !(
                    error instanceof BrowserToolError &&
                    error.code === "page_navigated"
                  )
                )
                  throw error;
                if (Date.now() >= deadline)
                  throw new BrowserToolError(
                    "wait_timeout",
                    "The page kept navigating while waiting for content.",
                    { url: this.page.getURL() },
                    "Wait for the current page to finish navigating and inspect it.",
                  );
                await new Promise((resolve) => setTimeout(resolve, 100));
                continue;
              }
              const matchesText =
                !step.text ||
                visible.text.toLowerCase().includes(step.text.toLowerCase());
              const matchesSelector =
                !step.selector ||
                (step.visible
                  ? visible.visibleRegions
                  : (visible.matchedRegions ?? 0)) > 0;
              if (matchesUrl && matchesText && matchesSelector) {
                report.result = {
                  matched: true,
                  url: this.page.getURL(),
                  scrollAttempts,
                  visible: step.visible ?? false,
                };
                break;
              }
              if (
                step.alsoTryScroll &&
                (scrollAttempts === 0 ||
                  (scrollAttempts === 1 && Date.now() >= deadline - 200)) &&
                (step.selector || step.text)
              ) {
                scrollAttempts++;
                try {
                  const id = step.ref
                    ? await nodeId(step)
                    : await browserTargetNode(this.page, {
                        selector: step.text ? undefined : step.selector,
                        text: step.text,
                        within: step.selector,
                        exact: false,
                        selection: "nearest",
                      });
                  await send("DOM.scrollIntoViewIfNeeded", {
                    backendNodeId: id,
                  });
                  await settleBrowserLayout(check);
                  continue;
                } catch (error) {
                  if (
                    !(
                      error instanceof BrowserToolError &&
                      error.code === "target_not_found"
                    )
                  )
                    throw error;
                }
              }
              if (Date.now() >= deadline) {
                const document = await this.read({
                  text: step.text,
                  selector: step.selector,
                  scope: "document",
                  limit: 4000,
                });
                throw new BrowserToolError(
                  "wait_timeout",
                  step.visible
                    ? "Timed out waiting for the requested visible content."
                    : "Timed out waiting for the requested document content.",
                  {
                    target: {
                      text: step.text,
                      selector: step.selector,
                      urlIncludes: step.urlIncludes,
                    },
                    foundInDocument:
                      step.selector && !step.text
                        ? document.matchedRegions > 0
                        : !!document.text,
                    visible: step.visible ?? false,
                    loading: this.page.isLoading(),
                    loadingHints: visible.loadingHints,
                    hasMoreBelow: visible.hasMoreBelow,
                    scrollAttempts,
                    viewport: {
                      width: visible.width,
                      height: visible.height,
                      scrollY: visible.scrollY,
                    },
                  },
                  step.visible && document.text
                    ? "The content exists outside the visible area or is covered. Scroll the target into view and inspect it."
                    : "Inspect the loading placeholder. Scroll the relevant region into view to trigger lazy loading, then wait again.",
                );
              }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            break;
          }
          case "back":
          case "forward":
          case "reload": {
            const history = this.page.navigationHistory;
            if (step.action === "back" && !history.canGoBack())
              throw Error("No previous page");
            if (step.action === "forward" && !history.canGoForward())
              throw Error("No next page");
            await new Promise<void>((resolve, reject) => {
              const wc = this.page;
              const finish = (error?: Error) => {
                clearInterval(timer);
                wc.removeListener("dom-ready", ready);
                wc.removeListener("did-navigate-in-page", inPage);
                error ? reject(error) : resolve();
              };
              const ready = () => finish();
              const inPage = (_event: unknown, _url: string, main: boolean) => {
                if (main) ready();
              };
              const deadline = Date.now() + 15000;
              const timer = setInterval(() => {
                try {
                  check();
                  if (Date.now() > deadline)
                    throw Error("Navigation timed out");
                } catch (error) {
                  finish(error as Error);
                }
              }, 100);
              wc.once("dom-ready", ready);
              wc.on("did-navigate-in-page", inPage);
              if (step.action === "back") history.goBack();
              else if (step.action === "forward") history.goForward();
              else wc.reload();
            });
            break;
          }
          case "zoom": {
            if (
              typeof step.factor !== "number" ||
              !Number.isFinite(step.factor) ||
              step.factor < 0.25 ||
              step.factor > 3
            )
              throw new BrowserToolError(
                "invalid_zoom",
                "Zoom factor must be between 0.25 and 3.",
                {},
                undefined,
                false,
              );
            this.page.setZoomFactor(step.factor);
            this.surfaceChanged();
            report.result = { zoomFactor: this.page.getZoomFactor() };
            break;
          }
          case "scroll_into_view":
          case "scroll_to_text":
          case "scroll": {
            if (step.ref || step.selector || step.text) {
              const deadline = Date.now() + (step.timeoutMs ?? 5000);
              let id: number;
              let targetRetries = 0;
              while (true) {
                check();
                try {
                  id = await nodeId(step);
                  await send("DOM.scrollIntoViewIfNeeded", {
                    backendNodeId: id,
                  });
                  break;
                } catch (error) {
                  const code = browserError(error).code;
                  const retryDetached =
                    code === "stale_ref" && targetRetries === 0;
                  if (
                    step.ref ||
                    !(code === "target_not_found" || retryDetached) ||
                    Date.now() >= deadline
                  )
                    throw error;
                  if (retryDetached) targetRetries++;
                  await new Promise((resolve) => setTimeout(resolve, 100));
                }
              }
              await settleBrowserLayout(check);
              report.result = { ...(await this.viewport()), targetRetries };
              break;
            }
            const { cssVisualViewport: bounds } = await send(
              "Page.getLayoutMetrics",
            );
            const x = step.x ?? bounds.clientWidth / 2,
              y = step.y ?? bounds.clientHeight / 2;
            const deltaX = step.deltaX ?? 0,
              deltaY = step.deltaY ?? Math.round(bounds.clientHeight * 0.8);
            if (
              ![x, y, deltaX, deltaY].every(Number.isFinite) ||
              x < 0 ||
              y < 0 ||
              x >= bounds.clientWidth ||
              y >= bounds.clientHeight
            )
              throw Error("Invalid scroll point or distance");
            await showBrowserPointer(this.page, x, y, "scroll");
            await send("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x,
              y,
              deltaX,
              deltaY,
            });
            await settleBrowserLayout(check);
            report.result = await this.viewport();
            break;
          }
          case "drag": {
            const start = await viewportPoint(step.x, step.y),
              end = await viewportPoint(step.toX, step.toY);
            const modifiers = modifierMask(step.modifiers);
            await send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              ...start,
              modifiers,
            });
            await this.waitForPointer(check);
            await showBrowserPointer(this.page, start.x, start.y, "drag");
            await send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              ...start,
              button: "left",
              clickCount: 1,
              modifiers,
            });
            try {
              for (let n = 1; n <= 8; n++) {
                const x = start.x + ((end.x - start.x) * n) / 8,
                  y = start.y + ((end.y - start.y) * n) / 8;
                await showBrowserPointer(this.page, x, y, "drag");
                await send("Input.dispatchMouseEvent", {
                  type: "mouseMoved",
                  x,
                  y,
                  button: "left",
                  buttons: 1,
                  modifiers,
                });
              }
            } finally {
              // Release the held button even when a handoff interrupts the gesture.
              await cleanup("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                ...end,
                button: "left",
                clickCount: 1,
                modifiers,
              }).catch(() => {});
            }
            break;
          }
          case "press": {
            const key = step.key;
            const codes: Record<string, number> = {
              Enter: 13,
              Tab: 9,
              Escape: 27,
              Space: 32,
              Backspace: 8,
              Delete: 46,
              ArrowLeft: 37,
              ArrowUp: 38,
              ArrowRight: 39,
              ArrowDown: 40,
              PageUp: 33,
              PageDown: 34,
              End: 35,
              Home: 36,
            };
            if (!key || (key.length !== 1 && !Object.hasOwn(codes, key)))
              throw Error("Unsupported key");
            const windowsVirtualKeyCode =
              codes[key] ?? key.toUpperCase().charCodeAt(0);
            const modifiers = modifierMask(step.modifiers);
            const actual = key === "Space" ? " " : key;
            await send("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: actual,
              modifiers,
              windowsVirtualKeyCode,
              text:
                modifiers & 7
                  ? undefined
                  : key === "Enter"
                    ? "\r"
                    : actual.length === 1
                      ? actual
                      : undefined,
            });
            await send("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: actual,
              modifiers,
              windowsVirtualKeyCode,
            });
            break;
          }
          case "select":
          case "hover":
          case "click":
          case "fill": {
            if (
              (step.action === "click" || step.action === "hover") &&
              (step.x !== undefined || step.y !== undefined)
            ) {
              if (
                step.action === "click" &&
                (step.modifiers?.includes("Control") ||
                  step.modifiers?.includes("Meta"))
              ) {
                const point = await viewportPoint(step.x, step.y);
                const { backendNodeId } = await send("DOM.getNodeForLocation", {
                  ...point,
                  includeUserAgentShadowDOM: true,
                });
                const { object } = await send("DOM.resolveNode", {
                  backendNodeId,
                });
                try {
                  const link = await modifiedLink(step, object.objectId);
                  if (link) {
                    report.result = link;
                    break;
                  }
                } finally {
                  await cleanup("Runtime.releaseObject", {
                    objectId: object.objectId,
                  }).catch(() => {});
                }
              }
              report.result = await pointer(
                step,
                await viewportPoint(step.x, step.y),
              );
              break;
            }
            const id = await nodeId(step);
            const { object } = await send("DOM.resolveNode", {
              backendNodeId: id,
            });
            const objectId: string = object.objectId;
            try {
              const link = await modifiedLink(step, objectId);
              if (link) {
                report.result = link;
                break;
              }
              await send("DOM.scrollIntoViewIfNeeded", { backendNodeId: id });
              if (step.action === "select" || step.action === "fill") {
                const { result } = await send("Runtime.callFunctionOn", {
                  objectId,
                  returnByValue: true,
                  functionDeclaration:
                    "function(){const r=this.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}}",
                });
                if (result.value)
                  await showBrowserPointer(
                    this.page,
                    result.value.x,
                    result.value.y,
                    "type",
                  );
              }
              if (step.action === "select") {
                if (typeof step.text !== "string")
                  throw Error("select requires an option value or label");
                const selection = await send("Runtime.callFunctionOn", {
                  objectId,
                  returnByValue: true,
                  arguments: [{ value: step.text }],
                  functionDeclaration:
                    "function(value){if(!(this instanceof HTMLSelectElement)||this.disabled)return false;const option=Array.from(this.options).find(o=>!o.disabled&&(o.value===value||o.label===value));if(!option)return false;this.value=option.value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return true}",
                });
                if (!selection.result.value)
                  throw Error("Select or option unavailable");
              } else if (step.action === "fill") {
                if (typeof step.text !== "string")
                  throw Error("fill requires text");
                await send("DOM.focus", { backendNodeId: id });
                const focused = await send("Runtime.callFunctionOn", {
                  objectId,
                  returnByValue: true,
                  functionDeclaration:
                    "function(){if(this.disabled||this.readOnly)return false;this.focus();if(typeof this.select==='function')this.select();else if(this.isContentEditable){const r=document.createRange();r.selectNodeContents(this);const s=getSelection();s.removeAllRanges();s.addRange(r)}else return false;return this.getRootNode().activeElement===this}",
                });
                if (!focused.result.value)
                  throw Error("Field cannot be edited");
                if (step.text)
                  await send("Input.insertText", { text: step.text });
                else {
                  await send("Input.dispatchKeyEvent", {
                    type: "keyDown",
                    key: "Backspace",
                    code: "Backspace",
                    windowsVirtualKeyCode: 8,
                  });
                  await send("Input.dispatchKeyEvent", {
                    type: "keyUp",
                    key: "Backspace",
                    code: "Backspace",
                    windowsVirtualKeyCode: 8,
                  });
                }
                const { result: filled } = await send(
                  "Runtime.callFunctionOn",
                  {
                    objectId,
                    returnByValue: true,
                    arguments: [{ value: step.text }],
                    functionDeclaration:
                      "function(expected){const actual=typeof this.value==='string'?this.value:this.textContent;return {matches:actual===expected,length:actual?.length??0}}",
                  },
                );
                if (!filled.value.matches)
                  throw new BrowserToolError(
                    "fill_mismatch",
                    "The field did not retain the requested text.",
                    {
                      requestedLength: step.text.length,
                      actualLength: filled.value.length,
                    },
                    "Inspect the field's input constraints before submitting.",
                  );
                report.result = {
                  inputDelivered: true,
                  characters: step.text.length,
                };
              } else {
                await this.waitForPointer(check);
                const { result } = await send("Runtime.callFunctionOn", {
                  objectId,
                  returnByValue: true,
                  functionDeclaration:
                    "function(){if(this.disabled||this.getAttribute('aria-disabled')==='true')return null;const r=this.getBoundingClientRect();const x=(Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,y=(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2;const hit=this.getRootNode().elementFromPoint(x,y);return hit&&(hit===this||this.contains(hit))?{x,y}:null}",
                });
                if (!result.value)
                  throw new BrowserToolError(
                    "target_obstructed",
                    "The target is covered, disabled, or outside the visible viewport.",
                    {
                      target: {
                        ref: step.ref,
                        selector: step.selector,
                        role: step.role,
                        name: step.name,
                        text: step.text,
                      },
                    },
                    "Inspect the visible page or close the overlay before retrying.",
                  );
                report.result = await pointer(step, result.value, objectId);
              }
            } finally {
              await cleanup("Runtime.releaseObject", { objectId }).catch(
                () => {},
              );
            }
            break;
          }
          default:
            throw Error("Unknown browser action");
        }
        completed++;
        report.status = "completed";
        report.urlAfter = this.page.getURL();
        report.documentChanged = this.epoch !== version;
      }
      check();
      if (input.snapshot !== false && !reads.length) {
        append(render(await scan(), undefined, true));
        content = await this.read({ scope: "main", limit: 4000 });
      }
      return {
        ok: true,
        status: "completed",
        completed,
        executedSteps: reports
          .filter((report) => report.status === "completed")
          .map((report) => report.step),
        steps: reports,
        url: this.page.getURL(),
        title: this.page.getTitle(),
        reads,
        readResults,
        content,
      };
    } catch (error) {
      const failure = browserError(error);
      const failedRef = (steps as Step[])[completed]?.ref;
      if (failure.code === "stale_ref" && failedRef)
        this.refs.delete(failedRef);
      const failedStep =
        "step" in failure && typeof failure.step === "number"
          ? failure.step
          : completed < steps.length
            ? completed + 1
            : undefined;
      const executedSteps = reports
        .filter((report) => report.status === "completed")
        .map((report) => report.step);
      const active = reports.at(-1);
      const interrupted = [
        "control_taken",
        "tab_closed",
        "cancelled",
        "page_changed",
      ].includes(failure.code);
      if (active?.status === "running") {
        active.status = interrupted ? "interrupted" : "failed";
        active.urlAfter = this.page.isDestroyed()
          ? undefined
          : this.page.getURL();
      }
      let snapshot: string | undefined;
      if (!this.page.isDestroyed() && failure.code !== "cancelled")
        snapshot = await browserCommand(
          this.page,
          "Accessibility.getFullAXTree",
          {},
          5000,
        )
          .then((value) => render(value.nodes, undefined, true))
          .catch(() => undefined);
      return {
        ok: false,
        status: interrupted ? "paused" : "failed",
        completed,
        executedSteps,
        failedStep,
        phase: failedStep === undefined ? "snapshot" : "steps",
        remainingSteps: steps
          .map((_step, index) => index + 1)
          .filter(
            (index) => index !== failedStep && !executedSteps.includes(index),
          ),
        steps: reports,
        reads,
        readResults,
        url: this.page.isDestroyed() ? undefined : this.page.getURL(),
        title: this.page.isDestroyed() ? undefined : this.page.getTitle(),
        error: {
          ...failure,
          ...(failure.code === "stale_ref"
            ? { documentVersion: this.epoch, ref: failedRef }
            : {}),
        },
        snapshot,
        recovery:
          "Completed steps remain applied. Inspect the failed step before retrying it, then rebuild only the unfinished steps using the fresh snapshot.",
      };
    }
  }
}
