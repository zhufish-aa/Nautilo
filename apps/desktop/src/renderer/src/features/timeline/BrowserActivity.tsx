import { useMemo, useState } from "react";
import { Check, Circle, Loader2, TriangleAlert } from "lucide-react";
import { browserActivity, browserStepLabel } from "../../lib/browser-display";
import { ProcessDisclosure } from "./ProcessDisclosure";

/** A browser window plus agent pointer, distinct from generic MCP plugs. */
export function BrowserActivityIcon({className=""}: {className?:string}) {
  return <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden><path d="M15.5 8V4.3A1.8 1.8 0 0 0 13.7 2.5H4.3a1.8 1.8 0 0 0-1.8 1.8v9.4a1.8 1.8 0 0 0 1.8 1.8H8M2.5 6h13"/><path d="m10 9 7 4.2-3.2.8-.8 3.2L10 9Z"/><path d="M5 4.25h.1m2 0h.1"/></svg>;
}
export function BrowserActivity({name,status,input,output,zh}: {name:string;status:"running"|"done"|"failed";input?:string;output?:string;zh:boolean}) {
  const [open,setOpen]=useState(false), [raw,setRaw]=useState(false);
  const {result,steps}=useMemo(()=>browserActivity(name,input,output),[name,input,output]);
  const done=steps.filter((step:any)=>step.status === "completed").length;
  const active=steps.find((step:any)=>step.status === "failed" || step.status === "running") ?? steps[0];
  const label=active ? browserStepLabel(active,zh) : zh?"浏览网页":"Browse page";
  const stepCount = steps.length > 1 && <span className="tabular-nums">{status === "running" ? `${done}/${steps.length}` : `${steps.length} ${zh ? "步" : "steps"}`}</span>;
  return <ProcessDisclosure className="tool-activity-card" icon={status === "failed" ? <TriangleAlert size={14} /> : <BrowserActivityIcon />}
    label={label} accessory={stepCount} open={open} onToggle={() => setOpen(value => !value)}
    running={status === "running"} failed={status === "failed"}>
      <ol className="space-y-1">
        {steps.map((step:any,index:number)=><li key={step.id ?? index} className="flex min-w-0 items-start gap-2 py-1 text-ink-2">
          <span className="mt-0.5 shrink-0">{step.status === "completed" ? <Check size={13} className="text-ok"/> : step.status === "failed" ? <TriangleAlert size={13} className="text-danger"/> : step.status === "running" ? <Loader2 size={13} className="animate-spin"/> : <Circle size={11} className="text-ink-3"/>}</span>
          <span className="min-w-0 break-words">{browserStepLabel(step,zh)}{step.error && <span className="mt-1 block text-xs text-danger">{step.error.message}</span>}</span>
          {step.verification?.verified && <span className="ml-auto shrink-0 text-[11px] text-ok">{zh?"已验证":"Verified"}</span>}
        </li>)}
      </ol>
      {result?.error && !steps.some((step:any)=>step.error) && <p className="mt-1 text-xs text-danger">{result.error.message}</p>}
      <button type="button" className="mt-1 py-1 text-xs text-ink-3 hover:text-ink" onClick={()=>setRaw(!raw)}>{raw?(zh?"收起原始数据":"Hide raw data"):(zh?"查看原始数据":"View raw data")}</button>
      {raw && <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-panel p-3 text-xs leading-relaxed">{output || input}</pre>}
  </ProcessDisclosure>;
}
