import { isDeepStrictEqual } from "node:util";
import { BrowserToolError } from "./browser-errors";

/** Accept both published spellings, but never silently choose conflicting values. */
export function browserArguments(input: any): any {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new BrowserToolError("INVALID_REQUEST", "Tool arguments must be an object.", {}, undefined, false);
  const result = { ...input };
  for (const [camel, snake] of Object.entries({profileId:"profile_id",tabId:"tab_id",spaceId:"space_id",timeoutMs:"timeout_ms",controlTimeoutMs:"control_timeout_ms",viewId:"view_id",jsonPath:"json_path",waitUntil:"wait_until"})) {
    if (result[snake] !== undefined && result[camel] !== undefined && !isDeepStrictEqual(result[snake],result[camel]))
      throw new BrowserToolError("INVALID_FIELD", `Conflicting ${camel} and ${snake}. Use either spelling, or the same value for both.`, {field:camel,alias:snake}, undefined, false);
    if (result[snake] !== undefined || result[camel] !== undefined) result[camel] = result[snake] = result[snake] ?? result[camel];
  }
  if (Array.isArray(result.steps)) result.steps = result.steps.map((step: any) => browserArguments(step));
  return result;
}

/** UI thumbnails stay in IPC; model-facing tools never inline their base64. */
export function browserPublicResult(value: any): any {
  if (Array.isArray(value)) return value.map(browserPublicResult);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "favicon").map(([key,item]) => [key,browserPublicResult(item)]));
}

const aliases: Record<string,string> = {ambiguous_target:"TARGET_AMBIGUOUS",target_obstructed:"TARGET_NOT_ACTIONABLE",browser_operation_timeout:"OPERATION_TIMEOUT",unknown_tab:"TAB_CLOSED",control_timeout:"CONTROL_TAKEN",browser_error:"BROWSER_ERROR"};
export function browserCode(code: string) { return aliases[code] ?? code.toUpperCase(); }

/** Opt-in v2 has a strict, small envelope; legacy content is losslessly namespaced. */
export function browserReceiptV2(input: Record<string,any>) {
  const {ok = true,status,steps = [],error,tab_id,tabId,current_tab_id,currentTabId,view_id,verified = false,
    failed_step,failedStep,executed_steps,executedSteps,remaining_steps,remainingSteps,...data} = input;
  const mapped = (steps as any[]).map((step,index) => ({step:step.step ?? index+1,id:step.id ?? "s"+(index+1),
    status:step.status === "interrupted" ? "failed" : step.status,
    ...(step.action ? {action:step.action}:{}),
    ...(step.dispatched ? {dispatched:step.dispatched}:{}),
    ...(step.observed ? {observed:step.observed}:{}),
    ...(step.result !== undefined ? {result:step.result}:{}),
    ...(step.verification ? {verification:step.verification}:{}),
    ...(step.ref_rebound ? {ref_rebound:true}:{}),
    ...(step.error ? {error:strictError(step.error)}:{}),
    ...(step.url_after || step.urlAfter ? {url_after:step.url_after ?? step.urlAfter}:{}),
  }));
  return {version:2,ok:!!ok,status:ok ? "completed" : status === "paused" || ["BROWSER_CLOSED","CONTROL_TAKEN","CANCELLED"].includes(browserCode(error?.code ?? "")) ? "paused" : "failed",
    verified:!!verified,steps:mapped,
    ...(tab_id ?? tabId ? {tab_id:tab_id ?? tabId}:{}),
    ...(current_tab_id ?? currentTabId ? {current_tab_id:current_tab_id ?? currentTabId}:{}),
    ...(view_id ? {view_id}:{}),
    ...(!ok ? {failed_step:failed_step ?? failedStep ?? 1,executed_steps:executed_steps ?? executedSteps ?? [],remaining_steps:remaining_steps ?? remainingSteps ?? [],error:strictError(error ?? {code:"BROWSER_ERROR",message:"Browser request failed"})}:{}),data};
}
function strictError(error: Record<string,any>) {
  const {code,message,retryable = true,recovery,...details} = error;
  return {code:browserCode(code ?? "BROWSER_ERROR"),message:String(message),retryable:!!retryable,...(recovery?{recovery}:{}),details};
}
