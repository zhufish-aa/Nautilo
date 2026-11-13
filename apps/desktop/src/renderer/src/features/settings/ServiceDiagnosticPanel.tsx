import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Activity, Check, ChevronDown, CircleAlert, Clock3, Plug, RefreshCw, Search, X } from "lucide-react";
import type { DiagnosticStage, ServiceDiagnostic } from "@agenthub/schemas";
import { useI18n } from "../../lib/i18n";
import { UI_EASE_OUT, useUiReducedMotion } from "../../lib/ui-motion";
import { diagnosticKey, useServiceDiagnostics, type DiagnosticTarget } from "../../stores/service-diagnostics";
import "./service-diagnostics.css";

const stageNames: Record<DiagnosticStage,[string,string]> = {
  configuration:["配置","Configuration"],credential:["凭据","Credential"],catalog:["模型目录","Model catalog"],launch:["启动传输","Transport"],initialize:["协议握手","Handshake"],tools:["工具清单","Tool inventory"]
};
const reasons: Record<string,[string,string]> = {
  AUTH_REQUIRED:["服务拒绝认证，请检查此连接的凭据。MCP 原生 OAuth 登录状态需在对应 Harness 中确认。","Authentication was rejected. Check this connection's credentials; native MCP OAuth belongs to the harness."],
  ENVIRONMENT_MISSING:["后端缺少配置引用的环境变量。","Referenced environment variables are missing from the daemon."],
  TIMEOUT:["服务未在限定时间内返回。","The service did not answer within its time limit."],
  SPAWN_FAILED:["无法启动 MCP，请检查可执行文件与工作目录。","Could not start MCP. Check its executable and working directory."],
  PROCESS_EXITED:["MCP 在返回检测结果前退出。","MCP exited before the check finished."],
  ENDPOINT_NOT_FOUND:["未找到 MCP 端点，请核对完整服务地址。","MCP endpoint not found. Check the full service URL."],
  CATALOG_NOT_SUPPORTED:["此地址未提供模型目录；这不代表它不能处理对话。","This endpoint does not expose a model catalog; inference may still be supported."],
  CATALOG_UNAVAILABLE:["未能读取模型目录，请检查地址、凭据或原生登录状态。","Could not read the catalog. Check the endpoint, credentials or native login."],
  CREDENTIAL_MISSING:["此连接没有保存 API Key，使用无认证请求检测。","No API key is stored; checking without authentication."],
  EMPTY_CATALOG:["服务返回了空模型目录。","The service returned an empty model catalog."],
  NO_TOOLS_CAPABILITY:["服务未声明工具能力，可能只提供资源或提示词。","This server advertises no tools; it may provide resources or prompts."],
  NETWORK_ERROR:["无法连接到服务，请检查网络、代理和地址。","Could not reach the service. Check network, proxy and endpoint."],
  PROTOCOL_ERROR:["服务返回的协议数据不符合预期。","The service returned an unexpected protocol response."],
  DISABLED:["此连接已停用。","This connection is disabled."],
  TOOL_LIST_LIMIT:["工具清单较大，已保留本次读取的结果。","The tool list reached the diagnostic limit; partial results are retained."]
};

export function DiagnosticStatus({target}: {target:DiagnosticTarget}): JSX.Element | null {
  const zh = useI18n().locale === "zh-CN", key = diagnosticKey(target);
  const result = useServiceDiagnostics(state=>state.results[key]);
  const checking = useServiceDiagnostics(state=>state.checking[key]);
  if (!result && !checking) return null;
  return <span className="service-status" data-state={checking ? "checking" : result?.state}>
    <span className="service-status-mark" aria-hidden>{checking ? <Activity size={12}/> : result?.state === "passed" ? <Check size={12}/> : result?.state === "failed" ? <X size={12}/> : <CircleAlert size={12}/>}</span>
    {checking ? (zh ? "检测中" : "Checking") : result?.state === "passed" ? (zh ? "检测通过" : "Verified") : result?.state === "failed" ? (zh ? "连接异常" : "Failed") : (zh ? "需确认" : "Review")}
  </span>;
}

export function ServiceDiagnosticPanel({target,disabled=false,initialOpen=false}: {target:DiagnosticTarget;disabled?:boolean;initialOpen?:boolean}): JSX.Element {
  const zh = useI18n().locale === "zh-CN", reduced = useUiReducedMotion(), key = diagnosticKey(target);
  const result = useServiceDiagnostics(state=>state.results[key]);
  const checking = useServiceDiagnostics(state=>state.checking[key]);
  const check = useServiceDiagnostics(state=>state.check);
  const [open,setOpen] = useState(initialOpen), [query,setQuery] = useState("");
  const checked = result ? new Date(result.checkedAt).toLocaleTimeString(zh ? "zh-CN" : "en-US",{hour:"2-digit",minute:"2-digit"}) : "";
  const tools = result?.tools?.filter(tool=>`${tool.name} ${tool.description??""}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const runCheck = () => { setOpen(true); void check(target); };
  return <section className="service-diagnostic" data-state={checking ? "checking" : result?.state ?? "unchecked"} aria-label={zh ? "连接诊断" : "Connection diagnostics"}>
    <div className="service-diagnostic-bar">
      <span className="service-diagnostic-symbol"><Plug size={16}/></span>
      <button className="service-diagnostic-heading" type="button" onClick={()=>setOpen(value=>!value)} aria-expanded={open}>
        <span>{zh ? "连接诊断" : "Connection diagnostics"}</span>
        <span className="service-diagnostic-summary">{checking ? (zh ? "正在与服务建立连接…" : "Connecting to the service…") : result ? diagnosticSummary(result,zh) : (zh ? "尚未检测" : "Not checked")}</span>
      </button>
      {result && !checking && <span className="service-diagnostic-checked"><Clock3 size={12}/>{checked}</span>}
      <button type="button" className="service-check-button" onClick={runCheck} disabled={disabled || checking} title={disabled ? (zh ? "请先保存修改" : "Save changes first") : undefined}>
        <RefreshCw size={14} className={checking ? "service-check-spinning" : undefined}/>{checking ? (zh ? "检测中" : "Checking") : result ? (zh ? "重新检测" : "Check again") : (zh ? "检测连接" : "Check connection")}
      </button>
      <button type="button" className="service-expand" aria-label={zh ? "展开诊断" : "Expand diagnostics"} onClick={()=>setOpen(value=>!value)} aria-expanded={open}><ChevronDown size={15} style={{transform:open ? "rotate(180deg)" : undefined}}/></button>
    </div>
    <AnimatePresence initial={false}>
      {open && <motion.div className="service-diagnostic-body" key={key} initial={{height:0,opacity:0}} animate={{height:"auto",opacity:1}} exit={{height:0,opacity:0}} transition={{duration:reduced ? 0 : 0.24,ease:UI_EASE_OUT}}>
        {checking && <div className="service-check-progress" role="status"><span className="service-breath-orbit" aria-hidden/><span>{zh ? "检测完成后会保留结果，可随时重新检测。" : "Results stay available; run a new check whenever needed."}</span></div>}
        {result && <>
          <ol className="service-check-steps">{result.steps.map((step,index)=><li key={`${step.id}:${index}`} data-state={step.state}>
            <span className="service-step-icon">{step.state === "passed" ? <Check size={13}/> : step.state === "failed" ? <X size={13}/> : <CircleAlert size={13}/>}</span>
            <div><span className="service-step-name">{stageNames[step.id][zh?0:1]}</span>{step.code && <p>{reasons[step.code]?.[zh?0:1] ?? step.message ?? step.code}</p>}
            {step.message && step.code && <details><summary>{zh ? "技术详情" : "Technical details"}</summary><pre>{step.message}</pre></details>}</div>
            <span className="service-step-time">{step.elapsedMs} ms</span>
          </li>)}</ol>
          {(result.tools?.length ?? 0) > 0 && <div className="service-tool-inventory">
            <div className="service-tool-heading"><h4>{zh ? "可用工具" : "Available tools"}<span>{result.toolCount}{result.truncated ? "+" : ""}</span></h4><label><Search size={13}/><input value={query} onChange={event=>setQuery(event.target.value)} aria-label={zh ? "筛选工具" : "Filter tools"} placeholder={zh ? "筛选工具" : "Filter tools"}/></label></div>
            <ul>{tools.map(tool=><li key={tool.name}><span>{tool.name}</span>{tool.description && <p>{tool.description}</p>}</li>)}</ul>
            {!tools.length && <p className="service-no-tools">{zh ? "没有匹配的工具" : "No matching tools"}</p>}
          </div>}
          <p className="service-check-scope">{result.scope === "mcp_handshake" ? (zh ? "独立 MCP 握手检测；原生会话的工具加载和 OAuth 状态以对应 Harness 为准。" : "Standalone MCP handshake. Native tool loading and OAuth remain harness-specific.") : (zh ? "仅检测模型目录，不发送对话，不验证模型推理或协议转换。" : "Catalog check only. No inference request; protocol conversion is not tested.")}</p>
        </>}
        {!result && !checking && <p className="service-check-scope">{zh ? "点击检测连接，读取服务的真实返回。" : "Check the connection to read the service's actual response."}</p>}
      </motion.div>}
    </AnimatePresence>
  </section>;
}
function diagnosticSummary(result:ServiceDiagnostic,zh:boolean): string {
  if (result.state === "failed") return zh ? "连接异常 · 查看原因" : "Failed · view reason";
  if (result.state === "warning") return zh ? "检测完成 · 有待确认项" : "Checked · review required";
  const detail = result.scope === "mcp_handshake" ? `${result.toolCount ?? 0}${zh ? " 个工具" : " tools"}` : `${result.modelCount ?? 0}${zh ? " 个模型" : " models"}`;
  return `${zh ? "检测通过" : "Verified"} · ${detail} · ${result.elapsedMs} ms`;
}
