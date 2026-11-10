import { useState } from "react";
import { LoaderCircle, LogIn, ArrowRight } from "lucide-react";
import { Dialog } from "../../components/ui/Dialog";
import { getBridge } from "../../lib/bridge";
import type { BrowserProfileResult } from "../../../../shared/browser-profile";

export function BrowserLoginDialog({open,onClose,zh}:{open:boolean;onClose:()=>void;zh:boolean}) {
  const [mode,setMode]=useState("login"),[url,setUrl]=useState(""),[endpoint,setEndpoint]=useState("http://127.0.0.1:9222");
  const [sites,setSites]=useState<NonNullable<BrowserProfileResult["sites"]>>([]),[selected,setSelected]=useState<string[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[result,setResult]=useState<BrowserProfileResult>();
  const invoke=async(command:"inspect"|"import"|"login")=>{
    setBusy(true);setError("");setResult(undefined);
    try {
      const result=await getBridge()!.browser!.profile(command,{url,endpoint,origins:selected});
      if(command === "inspect"){setSites(result.sites ?? []);setSelected([]);}
      else if(command === "login")onClose();else setResult(result);
    }catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  };
  return <Dialog open={open} onOpenChange={value=>{if(!value && !busy)onClose();}} title={zh?"浏览器登录态":"Browser sign-in"}>
    <div className="flex gap-1 rounded-xl bg-panel p-1">{[["login",zh?"在 Nautilo 登录":"Sign in here"],["import",zh?"从浏览器导入":"Import from browser"]].map(([value,label])=><button type="button" key={value} disabled={busy} className={`flex-1 rounded-lg px-3 py-2 text-sm ${mode === value?"bg-card text-ink shadow-sm":"text-ink-2"}`} onClick={()=>{setMode(value);setError("");setResult(undefined);}}>{label}</button>)}</div>
    <div className="mt-5 space-y-4">
      {mode === "login" ? <>
        <label className="block text-sm text-ink">{zh?"网站地址":"Website URL"}<input className="mt-2 h-10 w-full rounded-lg border border-line bg-card px-3 outline-none focus:border-accent" placeholder="https://…" value={url} onChange={event=>setUrl(event.target.value)}/></label>
        <button type="button" disabled={busy || !url.trim()} className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-ink text-card disabled:opacity-40" onClick={()=>void invoke("login")}>{busy?<LoaderCircle size={15} className="animate-spin"/>:<LogIn size={15}/>} {zh?"打开登录窗口":"Open sign-in window"}</button>
      </> : <>
        <label className="block text-sm text-ink">{zh?"本机浏览器调试地址":"Local browser debugging address"}<div className="mt-2 flex gap-2"><input className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-card px-3 outline-none focus:border-accent" value={endpoint} onChange={event=>{setEndpoint(event.target.value);setSites([]);setSelected([]);}}/><button type="button" disabled={busy} className="rounded-lg border border-line px-4 text-sm" onClick={()=>void invoke("inspect")}>{busy?<LoaderCircle size={15} className="animate-spin"/>:zh?"连接":"Connect"}</button></div></label>
        {!!sites.length && <fieldset className="max-h-60 space-y-1 overflow-auto rounded-xl border border-line p-2"><legend className="px-1 text-sm">{zh?"选择要导入登录态的网站":"Choose sites to import"}</legend>{[...new Map(sites.map(site=>[site.origin,site])).values()].map(site=><label key={site.origin} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-panel"><input type="checkbox" checked={selected.includes(site.origin)} onChange={event=>setSelected(current=>event.target.checked?[...current,site.origin]:current.filter(origin=>origin !== site.origin))}/><span className="min-w-0 truncate text-sm" title={site.title}>{site.origin}</span></label>)}</fieldset>}
        <button type="button" disabled={busy || !selected.length} className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-ink text-card disabled:opacity-40" onClick={()=>void invoke("import")}>{busy?<LoaderCircle size={15} className="animate-spin"/>:<ArrowRight size={15}/>} {zh?"导入选中网站的登录态":"Import selected sites"}</button>
      </>}
      {result && <div role="status" className="rounded-lg bg-ok/10 px-3 py-2 text-sm text-ink">{zh?`已导入 ${result.imported_cookies ?? 0} 条 Cookie。请刷新网页确认登录状态。`:`Imported ${result.imported_cookies ?? 0} cookies. Refresh the site to verify sign-in.`}</div>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  </Dialog>;
}
