import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { browserError } from "./browser-errors";
import { browserArguments, browserPublicResult, browserReceiptV2 } from "./browser-contract";
import expectSpec from "../../../../docs/browser/schemas/expect.schema.json";
import targetSpec from "../../../../docs/browser/schemas/target.schema.json";
import stepSpec from "../../../../docs/browser/schemas/step.schema.json";

// MCP clients receive self-contained schemas; they never fetch nautilo.dev $refs.
function inlineSpec(value: any, root: any = value): any {
  if (Array.isArray(value)) return value.map(item => inlineSpec(item, root));
  if (!value || typeof value !== "object") return value;
  if (value.$ref) {
    const source: any = value.$ref.startsWith("#/") ? root : value.$ref.endsWith("target.schema.json") ? targetSpec : expectSpec;
    const referenced = value.$ref.startsWith("#/") ? value.$ref.slice(2).split("/").reduce((node: any, key: string) => node[key], source) : source;
    return inlineSpec(referenced, source);
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("$") && !key.startsWith("x-")).map(([key, item]) => [key, inlineSpec(item, root)]));
}
const expectSchema = inlineSpec(expectSpec);
const stepSchema = inlineSpec(stepSpec);

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
        "goto", "dblclick", "assert", "eval", "screenshot",
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
      maximum: 120000,
      description:
        "Timeout for open (default 20000), wait (5000), or locating scroll targets (5000).",
    },
  },
};
Object.assign(actionSchema.properties, Object.fromEntries(Object.entries(stepSchema.properties).filter(([key]) => !Object.hasOwn(actionSchema.properties, key))));
const tabId = {
  type: "string",
  description:
    "Tab ID from browser_tabs. Omit for currentTabId consistently across tools, or use 'viewed' for the tab the user is viewing. Every result identifies the resolved tab.",
};
const tools: any[] = [
  {
    name: "browser_eval",
    description: "Evaluate a function/expression in the selected page and return up to 100 KB of JSON. Use for DOM/media state that rendered text cannot establish. Optional expect is a map of predicates, e.g. {paused:false,t:{gt:0}}; it polls the function until matched. Use only observational scripts when polling. Scripts may have side effects, so this tool requires agent control. Actions are never automatically replayed after a timeout.",
    inputSchema: { type: "object", required: ["script"], additionalProperties: false, properties: {
      tabId, tab_id: tabId, script: { type: "string", maxLength: 100000 }, arg: {}, expect: inlineSpec((expectSpec as any).$defs.predicateMap, expectSpec),
      timeout_ms: { type: "integer", minimum: 100, maximum: 120000 }, controlTimeoutMs: { type: "integer", minimum: 0, maximum: 60000 },
    } },
  },
  ...["browser_assert", "browser_wait"].map(name => ({
    name, description: "Wait for explicit URL, title, selector, text, script, popup or network conditions, polling every 250 ms. All conditions must match; timeout returns ASSERT_FAILED with actual and expected state. Prefer a browser_run step with expect for popups/network so observation starts before the triggering action. Pure DOM assertions work during user control; arbitrary scripts require agent control.",
    inputSchema: { type: "object", required: ["expect"], additionalProperties: false, properties: {
      tabId, tab_id: tabId, expect: expectSchema, timeout_ms: { type: "integer", minimum: 100, maximum: 120000 },
    } },
  })),
  {
    name: "browser_session", description: "Manage this conversation's browser lifecycle. list/open inspect its workspace; claim marks an available tab as agent-owned without overriding a user handoff. handoff stops writes until the user returns control. finish({keep:[tabId or label]}) closes only unused agent-created tabs; user-created, restored or edited tabs are protected. It cannot access another conversation's workspace.",
    inputSchema: { type: "object", required: ["action"], additionalProperties: false, properties: {
      action: { enum: ["open", "list", "claim", "handoff", "finish"] }, tabId, tab_id: tabId,
      keep: { type: "array", items: { type: "string" } },
    } },
  },
  {
    name: "browser_scroll",
    description:
      "Scroll the current tab by pixels or scroll a text/selector/ref into view. Pixel scrolling chooses a neutral point unless x/y are supplied, measures the document or nested scroll container, and returns moved, scroll_before/scroll_after, scroll_target and method. A bounded wheel attempt can fall back to absolute DOM scrolling; no movement returns SCROLL_NO_EFFECT, including boundaries, rather than completed. For lazy comments use selector or text:'评论', then browser_run wait and browser_read. No hidden scrolling during reads.",
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
      "Run up to thirty ordered steps. Legacy flat locators/arguments remain supported. target accepts ref (with or without @), css, xpath, role/name, text, href or x/y. Refs survive repeat snapshots of the same document; navigation invalidates them. Optional id defaults to s1, s2. expect verifies the result without repeating the action. Popup receipts include tab_id/label/url. follow:new_tab waits for and follows a popup; auto follows new tabs for URL/popup expectations; same_tab stays pinned. optional:true skips a failed step, except control/cancellation failures. Failures return exact completed/failed/remaining steps. verified:false is an action receipt, not a business-state guarantee. Never blindly replay completed or dispatched steps. Writes queue for control for 15000 ms by default. snapshot:false omits the final read.",
    inputSchema: {
      type: "object",
      required: ["steps"],
      additionalProperties: false,
      properties: {
        tabId,
        tab_id: tabId,
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
tools.push(
  {name:"browser_fetch",description:"Fetch in the current page with its cookies and relative URLs, respecting normal browser CORS. Returns response status, headers and bounded text/JSON. Non-GET requests can have side effects; requires agent control.",inputSchema:{type:"object",required:["url"],additionalProperties:false,properties:{tabId,url:{type:"string"},method:{type:"string"},headers:{type:"object",additionalProperties:{type:"string"}},body:{type:"string",maxLength:65536},response:{enum:["text","json"]},timeout_ms:{type:"integer",minimum:100,maximum:120000}}}},
  {name:"browser_paste",description:"Paste text and/or HTML through the native browser paste command into an optional target or the focused editor. Sends a real paste event and restores the previous system clipboard if it was not changed by the user. Requires agent control; does not clear existing content first.",inputSchema:{type:"object",additionalProperties:false,properties:{tabId,target:inlineSpec(targetSpec),text:{type:"string",maxLength:100000},html:{type:"string",maxLength:100000}}}},
  {name:"browser_events",description:"Watch, unwatch or read the selected page's bounded event journal. Watch Runtime.consoleAPICalled or Runtime.exceptionThrown for console output; unwatch stops recording the supplied methods. Page, Network, DOM and Log events are also supported. Download, filechooser and navigation events are recorded automatically. Use since/cursor for incremental reads.",inputSchema:{type:"object",required:["action"],additionalProperties:false,properties:{tabId,action:{enum:["list","watch","unwatch"]},methods:{type:"array",minItems:1,maxItems:10,items:{type:"string"}},since:{type:"integer",minimum:0},limit:{type:"integer",minimum:1,maximum:120}}}},
  {name:"browser_dialog",description:"List, arm, accept or dismiss alert/confirm/prompt/beforeunload dialogs in this tab. Arm a one-shot rule BEFORE the action that opens a blocking dialog; inspect list for pending dialogs. Nothing is accepted automatically without an explicit rule.",inputSchema:{type:"object",required:["action"],additionalProperties:false,properties:{action:{enum:["list","arm","accept","dismiss","disarm"]},tabId,space_id:{type:"string"},accept:{type:"boolean"},prompt_text:{type:"string"},type:{enum:["alert","confirm","prompt","beforeunload"]},since:{type:"integer",minimum:0}}}},
  {name:"browser_files",description:"Two download entry points: page-triggered downloads (including blob exports) are captured automatically; use list then save after clicking. action:download explicitly starts a known HTTP(S) URL; success there does not verify a page export button. Both share the source-tab download registry. list also returns recent page_errors when a page script failed before starting a download. Upload local files to a file input, arm/disarm a chooser, cancel downloads or save completed files. paths and save path must be absolute; save never overwrites an existing file. No automatic model-side file content dump.",inputSchema:{type:"object",required:["action"],additionalProperties:false,properties:{action:{enum:["list","upload","arm_chooser","disarm_chooser","download","save","cancel"]},tabId,space_id:{type:"string"},target:inlineSpec(targetSpec),paths:{type:"array",minItems:1,maxItems:20,items:{type:"string"}},url:{type:"string"},path:{type:"string"},download_id:{type:"string"},timeout_ms:{type:"integer",minimum:100,maximum:120000}}}},
  {name:"browser_cdp",description:"Page-scoped CDP escape hatch. Send Runtime/DOM/Page/Accessibility/Input/Network/Emulation commands to the selected tab. Commands are not replayed. Browser-wide target, profile and process operations are unavailable here; they would bypass conversation ownership. Returns bounded JSON. Side-effecting commands require agent control.",inputSchema:{type:"object",required:["method"],additionalProperties:false,properties:{tabId,space_id:{type:"string"},method:{type:"string"},params:{type:"object"},timeout_ms:{type:"integer",minimum:100,maximum:120000}}}},
);
const sessionTool = tools.find(tool=>tool.name === "browser_session");
Object.assign(sessionTool.inputSchema.properties,{action:{enum:["open","list","claim","handoff","finish","login"]},space_id:{type:"string"},name:{type:"string",minLength:1,maxLength:120},profile_id:{type:"string",pattern:"^[A-Za-z0-9_-]{1,80}$"},profileId:{type:"string",pattern:"^[A-Za-z0-9_-]{1,80}$"},isolated:{type:"boolean"},url:{type:"string"},show:{type:"boolean"}});
sessionTool.inputSchema.properties.action.enum.push("inspect_login","import_login");
Object.assign(sessionTool.inputSchema.properties,{endpoint:{type:"string",description:"Local Chrome debugging endpoint, e.g. http://127.0.0.1:9222"},origins:{type:"array",minItems:1,maxItems:20,items:{type:"string"}},target_id:{type:"string"}});
sessionTool.description += " inspect_login lists sites in an explicitly supplied local Chrome CDP endpoint; import_login copies cookies ONLY for requested origins into Nautilo, without copying profile files, changing the source browser or returning cookie values. Invoke import_login only for sites the user selected. Server authentication must still be checked after import.";
sessionTool.description += " Open with name creates/reuses an independent named browser space belonging to this conversation. Supply profile_id for a separate persistent login profile, or isolated:true for an in-memory context. Existing spaces never switch profiles implicitly. Pass space_id on subsequent tools to address it. Names owned by another conversation/user return SESSION_CONFLICT. login opens the supplied login URL, shows the window and hands control to the user; login persists in Nautilo's profile across restarts. It does not copy the user's other browser cookies.";
// Publish the same aliases for every tool, including flat and batched calls.
for (const tool of tools) {
  const properties = tool.inputSchema.properties as Record<string,unknown>;
  properties.space_id = {type:"string",description:"Named browser space returned by browser_session. Only spaces owned by this conversation are accessible."};
  for (const [camel,snake] of Object.entries({tabId:"tab_id",spaceId:"space_id",timeoutMs:"timeout_ms",controlTimeoutMs:"control_timeout_ms",viewId:"view_id",jsonPath:"json_path"})) {
    if (properties[camel] || properties[snake]) properties[camel] = properties[snake] = properties[camel] ?? properties[snake];
  }
  properties.contract_version = {type:"integer",enum:[1,2],default:1,description:"1 preserves existing responses; 2 returns the strict receipt envelope with uppercase errors and data payload."};
}
const readProperties=tools.find(tool=>tool.name === "browser_read").inputSchema.properties;
Object.assign(readProperties,{format:{enum:["text","refs"],default:"text"},root:{type:"string"},view_id:{type:"string"},viewId:{type:"string"},limit:{type:"integer",minimum:1,maximum:24000,description:"Character limit for text; node count 1–200 for format:refs."}});
Object.assign(actionSchema.properties,{expect:{anyOf:[expectSchema,inlineSpec((expectSpec as any).$defs.predicateMap,expectSpec)]}});
Object.assign(actionSchema.properties,{format:{enum:["text","refs"]},root:{type:"string"},view_id:{type:"string"},limit:{type:"integer",minimum:1,maximum:24000}});

export const browserCapabilities = {
  version:"1.2.1",tools:tools.map(tool=>tool.name),
  page_fetch:"browser_fetch",rich_text_paste:"browser_paste",
  console:{tool:"browser_events",actions:["watch","unwatch","list"],methods:["Runtime.consoleAPICalled","Runtime.exceptionThrown"]},
  contexts:{tool:"browser_session",action:"open",options:["name","profile_id","isolated"]},
  downloads:{tool:"browser_files",page_exports:"automatically recorded; list then save",known_url:"download then save",page_errors:"recent script errors in list"},
  windows:{first_call:"automatically opens",closed_during_request:"BROWSER_CLOSED",next_call:"automatically reopens"},
};
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
            serverInfo: { name: "Nautilo Browser", version: browserCapabilities.version },
            instructions:"The browser opens automatically on use. Closing it stops in-flight requests with BROWSER_CLOSED; the next tool call reopens it. CONTROL_TAKEN is a separate user handoff. browser_fetch performs page-context requests; browser_paste sends native text/HTML paste; browser_events watch/unwatch/list exposes console and page events; browser_session open supports profile_id and isolated contexts. Page exports including blob downloads are captured automatically: use browser_files list then save. browser_files download starts a known HTTP(S) URL and does not verify a page's export button. Use browser_state or browser_session list for the current capabilities and refresh an older cached tools/list if needed.",
            _meta:{"nautilo/browser_contract_versions":[1,2],"nautilo/browser_default_contract":1,"nautilo/browser_capabilities":browserCapabilities},
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
        const argumentsInput = rpc.params?.arguments ?? {};
        const version = argumentsInput.contract_version ?? 1;
        const format = (result: any) => {
          const blocks = "content" in result ? result.content : [result];
          let structured: any;
          const content = blocks.map((block: any) => {
            if (block.type !== "text") return block;
            try {
              const value = browserPublicResult(JSON.parse(block.text));
              structured = version === 2 ? browserReceiptV2(value) : value;
              return {...block,text:JSON.stringify(structured)};
            } catch { return block; }
          });
          return {content,...(result.isError?{isError:true}:{}),...(structured?{structuredContent:structured}:{})};
        };
        try {
          if (![1,2].includes(version)) throw Error("Supported contract_version values: 1, 2");
          const result = await execute(
            session,
            name,
            browserArguments(argumentsInput),
            abort.signal,
          );
          reply({
            result: format(result),
          });
        } catch (error) {
          const failure=browserError(error);
          const output = {
            ok: false,
            status: ["BROWSER_CLOSED","CONTROL_TAKEN","control_taken","cancelled"].includes(failure.code) ? "paused" : "failed",
            completed: 0,
            executedSteps: [],
            error: failure,
          };
          reply({
            result: format({
              isError: true,
              structuredContent: output,
              content: [
                {
                  type: "text",
                  text: JSON.stringify(output),
                },
              ],
            }),
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
