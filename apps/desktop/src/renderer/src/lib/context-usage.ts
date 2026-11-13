import type {RuntimeEvent} from "@agenthub/event-protocol";
import type {ContextUsage} from "./types";

/** Context capacity and occupancy are independent, last-known observations.
 * Accounting snapshots deliberately cannot erase either of them. */
export function latestContextUsage(events:readonly RuntimeEvent[]):ContextUsage|undefined {
  let contextUsed:number|undefined,contextWindow:number|undefined;
  for(let index=events.length-1;index>=0;index--){
    const event=events[index];if(event.type!=="usage.updated")continue;
    const value=event.payload;
    if(contextUsed===undefined&&typeof value.contextUsed==="number"&&Number.isSafeInteger(value.contextUsed)&&value.contextUsed>=0)contextUsed=value.contextUsed;
    if(contextWindow===undefined&&typeof value.contextWindow==="number"&&Number.isSafeInteger(value.contextWindow)&&value.contextWindow>0)contextWindow=value.contextWindow;
    if(contextUsed!==undefined&&contextWindow!==undefined)break;
  }
  return contextUsed!==undefined||contextWindow!==undefined?{contextUsed,contextWindow}:undefined;
}
