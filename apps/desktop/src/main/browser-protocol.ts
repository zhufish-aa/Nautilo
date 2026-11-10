import type { WebContents } from "electron";
import { BrowserToolError, browserDeadline } from "./browser-errors";
import {browserFrameProtocol} from "./browser-frame-protocol";

const connections = new WeakMap<WebContents, { generation: number }>();
const agentInput = new WeakMap<WebContents, number>();
export function isBrowserAgentInput(page: WebContents) { return (agentInput.get(page) ?? 0) > 0; }

/** Bound protocol requests and discard the connection after a hung request.
 * Never replay a command: input or navigation may already have taken effect. */
export async function browserCommand(
  page: WebContents,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15000,
  sessionId?:string,
) {
  let connection = connections.get(page);
  if (!connection) {
    connection = { generation: 0 };
    connections.set(page, connection);
    const state = connection;
    page.debugger.on("detach", () => state.generation++);
  }
  const api = page.debugger;
  if (!api.isAttached()) api.attach("1.3");
  const frames=browserFrameProtocol(page), routed=frames.route(method,params,sessionId);
  sessionId=routed.sessionId;params=routed.params;
  const generation = connection.generation;
  const input = method.startsWith("Input.");
  if (input) agentInput.set(page, (agentInput.get(page) ?? 0) + 1);
  try {
    await frames.prepare(method,sessionId);
    const result = await browserDeadline(
      api.sendCommand(method, params,sessionId),
      timeoutMs,
      method,
    );
    if (generation !== connection.generation)
      throw new BrowserToolError(
        "protocol_reset",
        "The browser inspection connection changed during this operation.",
        { operation: method },
        "Inspect the current page and obtain new refs before resuming unfinished steps.",
      );
    return await frames.receive(method,result,sessionId,params);
  } catch (error) {
    if (
      !(error instanceof BrowserToolError) ||
      error.code !== "browser_operation_timeout"
    )
      throw error;
    let cdpReset = false, rendererAlive=false;
    // Detaching from a genuinely blocked renderer loses the existing session's
    // interrupt channel. Probe first; reset only a responsive protocol target.
    if(!page.isDestroyed() && !(method === "Runtime.evaluate" && params.expression === "1")) {
      rendererAlive=await browserDeadline(api.sendCommand("Runtime.evaluate",{expression:"1",returnByValue:true,timeout:3000}),3000,"renderer timeout probe","probe").then(()=>true,()=>false);
    }
    if (rendererAlive && generation === connection.generation && !page.isDestroyed()) {
      connection.generation++;
      try {
        if (api.isAttached()) api.detach();
        api.attach("1.3");
        cdpReset = true;
      } catch {
        // A destroyed target or another debugger may prevent reconnection.
      }
    }
    throw new BrowserToolError(
      "browser_operation_timeout",
      error.message,
      { ...error.details, operation: method, timeoutMs, timeout_ms: timeoutMs, cdpReset,
        renderer_alive: rendererAlive },
      "The timed-out command was not replayed. Inspect the current page and obtain new refs before resuming unfinished steps.",
    );
  } finally {
    if (input) agentInput.set(page, Math.max(0, (agentInput.get(page) ?? 1) - 1));
  }
}

/** Rendering can pause in minimized windows. Yield on the host, never on RAF. */
export async function settleBrowserLayout(check: () => void) {
  await new Promise((resolve) => setTimeout(resolve, 32));
  check();
}
