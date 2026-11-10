import type { WebContents } from "electron";
import { isDeepStrictEqual } from "node:util";
import { browserCommand } from "./browser-protocol";
import { BrowserToolError } from "./browser-errors";

export type BrowserExpect = {
  url?: { equals?: string; includes?: string; matches?: string };
  title?: { contains?: string; matches?: string };
  selector?: { css: string; state?: "visible" | "attached" | "hidden" | "detached"; count?: Record<string, number> };
  text?: { css: string; contains?: string; equals?: string; matches?: string };
  eval?: { script: string; arg?: unknown; expect?: Record<string, unknown> };
  popup?: boolean;
  navigation?: { includes?: string; matches?: string };
  network?: { url_matches?: string; method?: string; status?: Record<string, number> };
  load_state?: "domcontentloaded" | "load";
  network_idle_ms?: number;
  event?: {type?:string;method?:string;since?:number;expect?:Record<string,unknown>};
};
export type BrowserObserved = {
  from: string;
  popups: () => { tab_id: string; label: string; url: string }[];
  network?: () => { url: string; method?: string; status: number }[];
  events?: () => {id:number;type:string;data:Record<string,unknown>}[];
  networkState?: () => {pending:number;idle_ms:number};
};

export function browserTimeout(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 100 || Number(value) > 120000)
    throw new BrowserToolError("INVALID_TIMEOUT", "timeout_ms (alias timeoutMs) must be an integer between 100 and 120000.", { value }, undefined, false);
  return Number(value);
}

export async function evaluateBrowser(page: WebContents, script: unknown, arg: unknown, check: () => void, timeoutMs = 5000) {
  const started=Date.now();
  if (typeof script !== "string" || !script.trim() || script.length > 100000)
    throw new BrowserToolError("SCRIPT_ERROR", "Provide a function or expression of at most 100000 characters.", {}, undefined, false);
  check();
  const encoded = JSON.stringify(arg ?? null);
  const expression = `(() => { const value = (${script}\n); return typeof value === 'function' ? value(${encoded}) : value; })()`;
  let result;
  try {
    result = await browserCommand(page, "Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs,
    }, timeoutMs + 250);
  } catch(error) {
    // Chromium can reject the protocol request with only "Internal error"
    // when V8's execution timeout interrupts a synchronous script.
    const elapsed=Date.now()-started, message=error instanceof Error ? error.message : String(error);
    if(!(error instanceof BrowserToolError) && elapsed >= timeoutMs-25 && /^(Internal error|.*execution.*(?:timed out|terminated).*)$/i.test(message))
      throw new BrowserToolError("browser_operation_timeout","The page script exceeded its execution timeout.",{
        operation:"Runtime.evaluate",timeout_class:"eval",timeout_ms:timeoutMs,elapsed_ms:elapsed,protocol_message:message,
      },"The script was interrupted at its execution limit and was not replayed. Inspect the page before retrying.");
    throw error;
  }
  check();
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    if(/execution.*(?:timed out|terminated)/i.test(String(details.exception?.description ?? details.text)))
      throw new BrowserToolError("browser_operation_timeout","The page script exceeded its execution timeout.",{operation:"Runtime.evaluate",timeout_class:"eval",timeout_ms:timeoutMs,elapsed_ms:Date.now()-started},"The script was not replayed. Inspect the page before retrying.");
    throw new BrowserToolError("SCRIPT_ERROR", String(details.exception?.description ?? details.text).split("\n").slice(0, 5).join("\n"), {}, "Correct the script; the failed script was not replayed.", false);
  }
  if (result.result?.unserializableValue || result.result?.objectId) {
    if (result.result.objectId) void browserCommand(page, "Runtime.releaseObject", { objectId: result.result.objectId }, 1000).catch(() => {});
    throw new BrowserToolError("SCRIPT_ERROR", "The script must return JSON data, not DOM nodes or other objects by reference.", {}, undefined, false);
  }
  const value: unknown = result.result?.value ?? null;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 100 * 1024)
    throw new BrowserToolError("SCRIPT_ERROR", "The script result exceeds 100 KB. Return a smaller selection.", {}, undefined, false);
  return value;
}

function matches(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected))
    return isDeepStrictEqual(actual, expected);
  const p = expected as Record<string, unknown>;
  const operators = Object.keys(p);
  const allowed = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "matches", "exists", "length_gte", "in"]);
  if (!operators.length || operators.some(key => !allowed.has(key)))
    throw new BrowserToolError("INVALID_EXPECT", "Unknown or empty assertion predicate.", { predicate: expected }, undefined, false);
  return operators.every(key => {
    const wanted = p[key];
    switch (key) {
      case "eq": return isDeepStrictEqual(actual, wanted);
      case "ne": return !isDeepStrictEqual(actual, wanted);
      case "exists": return (actual !== undefined && actual !== null) === wanted;
      case "contains": return typeof actual === "string" && actual.includes(String(wanted));
      case "matches": return typeof actual === "string" && regex(wanted).test(actual);
      case "in": return Array.isArray(wanted) && wanted.some(item => isDeepStrictEqual(item, actual));
      case "length_gte": return (typeof actual === "string" || Array.isArray(actual)) && actual.length >= Number(wanted);
      case "gt": return typeof actual === "number" && actual > Number(wanted);
      case "gte": return typeof actual === "number" && actual >= Number(wanted);
      case "lt": return typeof actual === "number" && actual < Number(wanted);
      case "lte": return typeof actual === "number" && actual <= Number(wanted);
      default: return false;
    }
  });
}

function regex(pattern: unknown): RegExp {
  if (typeof pattern !== "string" || pattern.length > 2000)
    throw new BrowserToolError("INVALID_EXPECT", "Provide a regular expression of at most 2000 characters.", {}, undefined, false);
  try { return new RegExp(pattern); }
  catch { throw new BrowserToolError("INVALID_EXPECT", "Invalid regular expression.", { pattern }, undefined, false); }
}

export function browserPredicates(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!expected || typeof expected !== "object" || Array.isArray(expected))
    throw new BrowserToolError("INVALID_EXPECT", "expect must be an object of value predicates.", {}, undefined, false);
  return Object.entries(expected).map(([path, predicate]) => {
    const value = path === "$" ? actual : path.split(".").reduce<unknown>((value, key) =>
      value !== null && typeof value === "object" && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined, actual);
    return matches(value, predicate);
  }).every(Boolean);
}

/** Poll only observations. An action that produced them is never replayed. */
export async function expectBrowser(page: WebContents, expect: BrowserExpect, observed: BrowserObserved, check: () => void, timeoutMs = 15000) {
  const allowed = new Set(["url", "title", "selector", "text", "eval", "popup", "navigation", "network", "load_state", "network_idle_ms", "event"]);
  if (!expect || typeof expect !== "object" || Array.isArray(expect) || !Object.keys(expect).length || Object.keys(expect).some(key => !allowed.has(key)))
    throw new BrowserToolError("INVALID_EXPECT", "Provide at least one supported expectation.", {}, undefined, false);
  const started = Date.now(), deadline = started + timeoutMs;
  let attempts = 0;
  let actual: Record<string, unknown> = {};
  do {
    check();
    attempts++;
    actual = {};
    const checks: boolean[] = [];
    const stringCondition = (key: string, value: string, condition: Record<string, string | undefined>) => {
      actual[key] = value;
      for (const [operator, expected] of Object.entries(condition)) {
        if (expected === undefined) continue;
        checks.push(operator === "matches" ? regex(expected).test(value) : operator === "equals" ? value === expected : value.includes(expected));
      }
    };
    if (expect.url) stringCondition("url", page.getURL(), expect.url);
    if (expect.title) stringCondition("title", page.getTitle(), expect.title);
    if (expect.navigation) {
      checks.push(observed.from !== page.getURL());
      stringCondition("navigation", page.getURL(), expect.navigation);
    }
    if (expect.selector || expect.text) {
      const selection = await evaluateBrowser(page, `(arg) => {
        const visible = n => !!n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden' && getComputedStyle(n).display !== 'none';
        const nodes = arg.selector ? Array.from(document.querySelectorAll(arg.selector.css)) : [];
        return { count: nodes.length, visible: nodes.some(visible), text: arg.text ? Array.from(document.querySelectorAll(arg.text.css)).slice(0,200).map(n=>n.innerText ?? n.textContent ?? '').join('\\n').slice(0,24000) : '' };
      }`, { selector: expect.selector, text: expect.text }, check, Math.max(100, Math.min(3000, deadline - Date.now())));
      const value = selection as { count: number; visible: boolean; text: string };
      if (expect.selector) {
        actual.selector = { count: value.count, visible: value.visible };
        const state = expect.selector.state ?? "attached";
        checks.push(state === "visible" ? value.visible : state === "hidden" ? !value.visible : state === "detached" ? value.count === 0 : value.count > 0);
        if (expect.selector.count) checks.push(matches(value.count, expect.selector.count));
      }
      if (expect.text) {
        const { css: _css, ...condition } = expect.text;
        stringCondition("text", value.text, condition);
      }
    }
    if (expect.eval) {
      const value = await evaluateBrowser(page, expect.eval.script, expect.eval.arg, check, Math.max(100, Math.min(5000, deadline - Date.now())));
      actual.eval = value;
      checks.push(expect.eval.expect ? browserPredicates(value, expect.eval.expect) : value === true);
    }
    if (expect.popup !== undefined) {
      actual.popups = observed.popups();
      checks.push((observed.popups().length > 0) === expect.popup);
    }
    if (expect.network) {
      const condition = expect.network;
      const requests = observed.network?.() ?? [];
      actual.network = requests;
      checks.push(requests.some(value => (!condition.url_matches || regex(condition.url_matches).test(value.url)) &&
        (!condition.method || value.method === condition.method) && (!condition.status || matches(value.status, condition.status))));
    }
    if(expect.load_state) {
      actual.load_state=await evaluateBrowser(page,"() => document.readyState",undefined,check,Math.max(100,Math.min(3000,deadline-Date.now())));
      checks.push(expect.load_state === "load" ? actual.load_state === "complete" : actual.load_state === "interactive" || actual.load_state === "complete");
    }
    if(expect.network_idle_ms !== undefined) {
      if(!Number.isInteger(expect.network_idle_ms) || expect.network_idle_ms<100 || expect.network_idle_ms>10000)throw new BrowserToolError("INVALID_EXPECT","network_idle_ms must be between 100 and 10000.");
      const network=observed.networkState?.();actual.network_idle=network;
      checks.push(!!network && network.pending === 0 && network.idle_ms>=expect.network_idle_ms);
    }
    if(expect.event) {
      const event=expect.event;
      if(!event.type && !event.method)throw new BrowserToolError("INVALID_EXPECT","event requires type or a protocol method name.");
      const found=(observed.events?.() ?? []).filter(item=>(event.since === undefined || item.id>event.since) && (!event.type || item.type === event.type) && (!event.method || item.data.method === event.method));
      actual.events=found;
      checks.push(found.some(item=>!event.expect || browserPredicates(item.data,event.expect)));
    }
    if (checks.length && checks.every(Boolean)) return { verified: true, actual, attempts, elapsed_ms: Date.now() - started };
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
  } while (true);
  throw new BrowserToolError("ASSERT_FAILED", "The expected browser state was not reached before the timeout.", {
    actual, expected: expect, timeout_ms: timeoutMs, attempts, elapsed_ms: Date.now() - started,
    diff: ("Actual " + JSON.stringify(actual) + "; expected " + JSON.stringify(expect)).slice(0, 200),
  }, "Inspect the actual state. Do not repeat actions that have already been dispatched.");
}
