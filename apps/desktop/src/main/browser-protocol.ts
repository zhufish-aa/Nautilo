import type { WebContents } from "electron";
import { BrowserToolError, browserDeadline } from "./browser-errors";

const connections = new WeakMap<WebContents, { generation: number }>();

/** Bound protocol requests and discard the connection after a hung request.
 * Never replay a command: input or navigation may already have taken effect. */
export async function browserCommand(
  page: WebContents,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15000,
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
  const generation = connection.generation;
  try {
    const result = await browserDeadline(
      api.sendCommand(method, params),
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
    return result;
  } catch (error) {
    if (
      !(error instanceof BrowserToolError) ||
      error.code !== "browser_operation_timeout"
    )
      throw error;
    let cdpReset = false;
    if (generation === connection.generation && !page.isDestroyed()) {
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
      { operation: method, timeoutMs, cdpReset },
      "The timed-out command was not replayed. Inspect the current page and obtain new refs before resuming unfinished steps.",
    );
  }
}

/** Rendering can pause in minimized windows. Yield on the host, never on RAF. */
export async function settleBrowserLayout(check: () => void) {
  await new Promise((resolve) => setTimeout(resolve, 32));
  check();
}
