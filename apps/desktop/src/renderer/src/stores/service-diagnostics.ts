import { create } from "zustand";
import type { ServiceDiagnostic } from "@agenthub/schemas";
import { requestCore } from "../lib/bridge";

export type DiagnosticTarget = { kind:"connection" | "mcp"; id:string; version:string };
export const diagnosticKey = ({kind,id,version}: DiagnosticTarget) => JSON.stringify([kind,id,version]);
const inFlight = new Map<string,Promise<ServiceDiagnostic>>();
interface DiagnosticStore {
  results: Record<string,ServiceDiagnostic | undefined>;
  checking: Record<string,boolean | undefined>;
  check: (target:DiagnosticTarget) => Promise<ServiceDiagnostic>;
}
/** Results survive page switches. Only an explicit check performs network/CLI work. */
export const useServiceDiagnostics = create<DiagnosticStore>((set) => ({
  results:{},checking:{},
  check: target => {
    const key = diagnosticKey(target), existing = inFlight.get(key);
    if (existing) return existing;
    set(state=>({checking:{...state.checking,[key]:true}}));
    const started = performance.now();
    const request = requestCore<ServiceDiagnostic>(target.kind === "mcp" ? "capability.diagnose" : "connection.diagnose",target.kind === "mcp" ? {capabilityId:target.id} : {connectionId:target.id,revision:Number(target.version)})
      .catch((error): ServiceDiagnostic => ({subjectId:target.id,configurationVersion:target.version,scope:target.kind === "mcp" ? "mcp_handshake" : "api_catalog",state:"failed",checkedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started),steps:[{id:"configuration",state:"failed",elapsedMs:0,code:"IPC_ERROR",message:error instanceof Error ? error.message : String(error)}]}))
      .then(result=>{
        set(state=>({results:Object.fromEntries([...Object.entries(state.results).filter(([id])=>id!==key).slice(-59),[key,result]])}));
        return result;
      }).finally(()=>{
        inFlight.delete(key);
        set(state=>({checking:{...state.checking,[key]:false}}));
      });
    inFlight.set(key,request);
    return request;
  }
}));
