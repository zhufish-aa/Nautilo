import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { browserError } from "./browser-errors";

const actionSchema = {
  type: "object",
  required: ["action"],
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [
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
      ],
    },
    url: { type: "string" },
    waitUntil: {
      type: "string",
      enum: ["domcontentloaded", "load"],
      default: "domcontentloaded",
      description:
        "open loading state. DOM ready is the default; load also waits for subresources. SPA targets can render later: scroll locators wait up to timeoutMs (default 5000).",
    },
    ref: { type: "string" },
    role: { type: "string" },
    name: { type: "string" },
    text: { type: "string" },
    selector: {
      type: "string",
      description: "CSS selector, including elements inside open shadow roots.",
    },
    scope: { type: "string", enum: ["viewport", "document", "main"] },
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 256, maximum: 24000 },
    jsonPath: {
      type: "string",
      description: "Read a JSON subtree, e.g. $.data.replies[0].",
    },
    alsoTryScroll: {
      type: "boolean",
      description:
        "wait may scroll its target into view once to trigger lazy loading.",
    },
    factor: {
      type: "number",
      minimum: 0.25,
      maximum: 3,
      description: "zoom factor; 1 is 100%.",
    },
    urlIncludes: {
      type: "string",
      description: "wait until the URL contains this text.",
    },
    visible: {
      type: "boolean",
      default: false,
      description:
        "wait defaults to text/element present in the loaded document. Set true to require viewport visibility. alsoTryScroll:true opts into scrolling.",
    },
    key: {
      type: "string",
      description:
        "Key for press, e.g. Enter, Tab, Escape, ArrowDown or a letter.",
    },
    deltaY: {
      type: "number",
      description: "Scroll distance in CSS pixels; negative scrolls up.",
    },
    deltaX: { type: "number" },
    toX: { type: "number", description: "Drag destination viewport X." },
    toY: { type: "number", description: "Drag destination viewport Y." },
    button: { type: "string", enum: ["left", "middle", "right"] },
    clickCount: { type: "integer", minimum: 1, maximum: 2 },
    modifiers: {
      type: "array",
      items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] },
    },
    x: {
      type: "number",
      description: "Viewport X in CSS pixels for click, hover, drag or scroll.",
    },
    y: {
      type: "number",
      description: "Viewport Y in CSS pixels for click, hover, drag or scroll.",
    },
    timeoutMs: {
      type: "integer",
      minimum: 100,
      maximum: 60000,
      description:
        "Timeout for open (default 20000), wait (5000), or locating scroll targets (5000).",
    },
  },
};
const tabId = {
  type: "string",
  description:
    "Tab ID from browser_tabs. Omit for currentTabId consistently across tools, or use 'viewed' for the tab the user is viewing. Every result identifies the resolved tab.",
};
const tools = [
  {
    name: "browser_scroll",
    description:
      "Scroll the current tab by pixels or scroll a text/selector/ref into view. For lazy comments use selector or text:'评论', then browser_run wait and browser_read. No hidden scrolling during reads.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tabId,
        selector: {
          type: "string",
          description:
            "Read a precise region. Inputs, textareas and selects return current values in fields[]. Password values are redacted.",
        },
        text: { type: "string" },
        ref: { type: "string" },
        deltaY: { type: "number" },
        deltaX: { type: "number" },
        x: { type: "number" },
        y: { type: "number" },
        controlTimeoutMs: { type: "integer", minimum: 0, maximum: 60000 },
      },
    },
  },
  {
    name: "browser_state",
    description:
      "Inspect a tab's URL, loading, control, viewport, zoom, scroll, history and cookie-presence indicators. Coordinates use CSS pixels. Cookie values are never returned. Session cookies alone do not verify server-side login. Optional sessionCookies names and authenticatedSelector return explicit local evidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tabId,
        sessionCookies: {
          type: "array",
          maxItems: 20,
          items: { type: "string" },
        },
        authenticatedSelector: { type: "string" },
      },
    },
  },
  {
    name: "browser_wait_for_control",
    description:
      "Wait for the user to finish controlling a tab or for an existing browser batch to finish. Also available as browser_run step action:wait_for_control. Keeps the requested tab pinned. Returns readiness or a structured timeout without performing browser actions. Mutating batches queue automatically by default.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tabId,
        timeoutMs: { type: "integer", minimum: 0, maximum: 60000 },
      },
    },
  },
  {
    name: "browser_tabs",
    description:
      "List, create, select or close tabs. currentTabId is the consistent default for all browser tools. Each tab marks current and viewed, so the user can browse another tab independently. Use tabId:'viewed' to inspect their page. new optionally opens a URL; select changes currentTabId. Reads work during user control. Batches stay on their original tab.",
    inputSchema: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["list", "new", "select", "close"] },
        tabId,
        url: { type: "string" },
      },
    },
  },
  {
    name: "browser_read",
    description:
      "Read the currentTabId or an explicit tab. Use tabId:'viewed' for the user's page. Default scope viewport reads visible text. scope main extracts the article/main region with less navigation noise. selector reads a precise region, including open shadow DOM. scope document reads all currently loaded text. JSON pages use the original loaded response, including collapsed content; jsonPath extracts a subtree. Follow nextOffset with the SAME tabId, selector, scope and jsonPath until absent. Works during user control without moving the page. If loadingHints are present, browser_scroll to the region, wait, then read again; loading placeholders and login banners do not establish that content is unavailable.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tabId,
        scope: { type: "string", enum: ["viewport", "document", "main"] },
        selector: { type: "string" },
        jsonPath: { type: "string" },
        limit: { type: "integer", minimum: 256, maximum: 24000 },
        text: { type: "string" },
        offset: {
          type: "integer",
          minimum: 0,
          description:
            "Continue from this character offset. An offset beyond totalCharacters returns outOfRange:true.",
        },
      },
    },
  },
  {
    name: "browser_run",
    description:
      "Run steps on currentTabId or an explicit tab: open, read, click, fill, wait, scroll, scroll_into_view, scroll_to_text, hover, drag, press, select, back, forward, reload, zoom. Targets accept ref, selector, role+name, or exact visible text; click/hover also accept CSS-pixel x/y. Ref validity ends at navigation. Reads support scope/selector/offset/jsonPath. wait accepts text, selector or urlIncludes; alsoTryScroll:true explicitly enables lazy-load scrolling. Search example: fill textbox then press Enter then wait urlIncludes. Comments example: scroll_to_text 评论 then wait 回复 then read the comments selector. Zoom factor 1.5 enlarges QR codes. A batch pins its tab. Returns structured per-step reports on success AND failure, including completed steps, failedStep, remainingSteps, current URL and recovery. Completed side effects stay applied: never replay the whole batch blindly. Writes queue for control up to controlTimeoutMs (default 15000), with 0 for immediate feedback. snapshot:false omits the final compact control snapshot.",
    inputSchema: {
      type: "object",
      required: ["steps"],
      additionalProperties: false,
      properties: {
        tabId,
        steps: { type: "array", maxItems: 30, items: actionSchema },
        snapshot: { type: "boolean" },
        controlTimeoutMs: { type: "integer", minimum: 0, maximum: 60000 },
      },
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture currentTabId or an explicit tab, including during user control. Returns an image plus CSS viewport and image dimensions. Images default to CSS pixel size, so coordinates match click/hover. Optional clip is in CSS viewport pixels. Transient surface failures retry automatically without reloading or resizing the page. Use tabId:'viewed' for the user's page.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        scale: { type: "string", enum: ["css", "device"] },
        clip: {
          type: "object",
          required: ["x", "y", "width", "height"],
          additionalProperties: false,
          properties: {
            x: { type: "number", minimum: 0 },
            y: { type: "number", minimum: 0 },
            width: { type: "number", exclusiveMinimum: 0 },
            height: { type: "number", exclusiveMinimum: 0 },
          },
        },
      },
      additionalProperties: false,
    },
  },
];
type Content =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: "image/jpeg"; data: string };
export type BrowserToolResult = {
  content: Content[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
type Execute = (
  id: string,
  name: string,
  args: any,
  signal: AbortSignal,
) => Promise<Content | BrowserToolResult>;

export async function listenBrowserMcp(
  key: () => string,
  execute: Execute,
): Promise<Server> {
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing local browser endpoint");
  const port = address.port;
  const inFlight = new Map<string, AbortController>();
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const match = /^\/mcp\/([A-Za-z0-9_-]{1,160})$/.exec(req.url ?? "");
    if (
      req.headers.host !== "127.0.0.1:" + port ||
      req.headers.origin ||
      !match
    ) {
      res.writeHead(403).end();
      return;
    }
    const session = match[1];
    const expected = Buffer.from(
      "Bearer " +
        createHmac("sha256", key())
          .update("nautilo-browser-v1/" + port + "/" + session)
          .digest("base64url"),
    );
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    ) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (
      req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json"
    ) {
      res.writeHead(415).end();
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 128 * 1024) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      res.writeHead(400).end();
      return;
    }
    if (rpc.id === undefined) {
      if (rpc.method === "notifications/cancelled")
        inFlight
          .get(session + "/" + JSON.stringify(rpc.params?.requestId))
          ?.abort();
      res.writeHead(202).end();
      return;
    }
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    const reply = (value: object) => {
      if (!res.destroyed)
        res
          .writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          })
          .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...value }));
    };
    switch (rpc.method) {
      case "initialize": {
        const version = rpc.params?.protocolVersion;
        reply({
          result: {
            protocolVersion: [
              "2024-11-05",
              "2025-03-26",
              "2025-06-18",
              "2025-11-25",
            ].includes(version)
              ? version
              : "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "Nautilo Browser", version: "1.0.0" },
          },
        });
        break;
      }
      case "ping":
        reply({ result: {} });
        break;
      case "tools/list":
        reply({ result: { tools } });
        break;
      case "tools/call": {
        const name = rpc.params?.name;
        if (!tools.some((t) => t.name === name)) {
          reply({ error: { code: -32602, message: "Unknown tool" } });
          break;
        }
        const callId = session + "/" + JSON.stringify(rpc.id);
        if (inFlight.has(callId)) {
          reply({
            error: { code: -32600, message: "Duplicate active request id" },
          });
          break;
        }
        inFlight.set(callId, abort);
        try {
          const result = await execute(
            session,
            name,
            rpc.params?.arguments ?? {},
            abort.signal,
          );
          reply({
            result: "content" in result ? result : { content: [result] },
          });
        } catch (error) {
          const output = {
            ok: false,
            status: "failed",
            completed: 0,
            executedSteps: [],
            error: browserError(error),
          };
          reply({
            result: {
              isError: true,
              structuredContent: output,
              content: [
                {
                  type: "text",
                  text: JSON.stringify(output),
                },
              ],
            },
          });
        } finally {
          inFlight.delete(callId);
        }
        break;
      }
      default:
        reply({ error: { code: -32601, message: "Method not found" } });
    }
  }
  return server;
}
