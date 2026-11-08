import {useEffect,useState} from "react";
import type {CoreFeatures} from "@agenthub/schemas";
import {requestCore} from "./bridge";

let pending:Promise<CoreFeatures>|undefined;
function readFeatures():Promise<CoreFeatures>{
  if(!pending)pending=requestCore<{features?:CoreFeatures}>("health.get").then(result=>result.features??{}).catch(error=>{pending=undefined;throw error;});
  return pending;
}
/** Keep new operations hidden while an older daemon still owns live terminals. */
export function useCoreFeatures():CoreFeatures {
  const [features,setFeatures]=useState<CoreFeatures>({});
  useEffect(()=>{let disposed=false,timer:number|undefined;const read=():void=>{void readFeatures().then(value=>{if(!disposed)setFeatures(value);}).catch(()=>{if(!disposed)timer=window.setTimeout(read,2000);});};read();return()=>{disposed=true;window.clearTimeout(timer);};},[]);
  return features;
}
