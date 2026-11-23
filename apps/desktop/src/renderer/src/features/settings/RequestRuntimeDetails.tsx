import { ChevronRight, Snowflake, Zap, ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import type { RequestLog } from "@agenthub/schemas";
import { ms } from "./request-log-display";

const reasons: Record<string, [string, string]> = {
  resident: ["同身份常驻连接", "Same resident identity"], first_use: ["首次使用", "First use"],
  configuration_changed: ["配置身份已变化", "Configuration identity changed"], session_changed: ["原生会话已变化", "Native session changed"],
  process_exited: ["原生进程已退出", "Native process exited"], transport_recovery: ["恢复原生传输", "Native transport recovery"],
  protocol_single_use: ["原生协议要求单次进程", "Protocol requires a single-use process"],
};

export function RequestRuntimeLine({ row, zh, raw }: { row: RequestLog; zh: boolean; raw: boolean }) {
  const runtime = row.runtime;
  if (!runtime) return null;
  const reused = runtime.reused;
  const reason = runtime.reason && (reasons[runtime.reason]?.[zh ? 0 : 1] ?? runtime.reason);
  if (typeof reused !== "boolean" && runtime.pid == null && runtime.attachMs == null && !runtime.transport && !reason && !row.mcp) return null;
  return <div className="request-runtime-line">
    {typeof reused === "boolean" && <strong data-tone={reused ? "good" : "slow"}>
      {reused ? <Zap size={13} /> : <Snowflake size={13} />}
      {reused ? (zh ? "复用原生进程" : "Native process reused") : (zh ? "冷启动进程" : "Cold start")}
    </strong>}
    {runtime.attachMs != null && <span title={zh ? "进程附接耗时" : "Process attachment time"}>{ms(runtime.attachMs)}</span>}
    {runtime.pid != null && <span>PID {runtime.pid}</span>}
    {runtime.transport && <span>{runtime.transport}</span>}
    {reason && <span>{reason}</span>}
    {row.mcp && !raw && <a className="request-runtime-mcp" href="#request-trace-resources" onClick={event => {
      event.preventDefault();
      const details = event.currentTarget.closest(".request-trace")?.querySelector<HTMLDetailsElement>("#request-trace-resources");
      if (details) { details.open = true; details.scrollIntoView({ block: "nearest" }); }
    }}>MCP · {zh ? "绑定进程与握手" : "Processes & handshakes"}</a>}
  </div>;
}

export function RequestRuntimeDetails({ row, zh }: { row: RequestLog; zh: boolean }) {
  const t = (cn: string, en: string) => zh ? cn : en;
  const startup = row.runtime?.startupTimings;
  const opening = startup?.openDetails;
  const timings = [
    [t("运行配置准备", "Runtime preparation"), startup?.prepareMs],
    [t("加载原生运行环境", "Native runtime loading"), startup?.bootstrapMs],
    [t("打开原生会话", "Native session opening"), startup?.sessionOpenMs],
    [t("绑定提供方", "Provider binding"), opening?.providerBindMs],
    [t("等待原生插件", "Native plugin wait"), opening?.loaderWaitMs],
    [t("更新连接配置", "Provider update"), opening?.providerUpdateMs],
    [t("创建会话", "Session creation"), opening?.sessionCreateMs],
    [t("恢复 Agent", "Agent attachment"), opening?.agentResolveMs],
    [t("应用会话选项", "Session options"), opening?.preferencesMs],
  ] as const;
  const tools = new Set([...row.observedTools, ...(row.nativeTools ?? []), ...row.suppliedTools]);
  const servers = new Set([...row.suppliedServers, ...(row.nativeServers ?? []).map(server => server.name), ...(row.mcp?.servers ?? []).map(server => server.name)]);
  const sections = [
    [t("观察到的工具", "Observed tools"), row.observedTools],
    [t("原生报告的工具", "Native-reported tools"), row.nativeTools],
    [t("传入工具", "Supplied tools"), row.suppliedTools],
    [t("传入 MCP 服务", "Supplied MCP servers"), row.suppliedServers],
    [t("原生报告的 MCP 服务", "Native-reported MCP servers"), row.nativeServers?.map(server => [server.name, server.status].filter(Boolean).join(" · "))],
  ] as const;
  return <>
    {startup && <details className="request-trace-disclosure">
      <summary><ChevronRight size={14} />{t("原生启动明细", "Native startup timings")}</summary>
      <dl className="request-key-values">
        {timings.filter(([, value]) => value != null).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{ms(value)}</dd></div>)}
        {opening?.pendingPlugins?.length ? <div><dt>{t("等待插件", "Pending plugins")}</dt><dd>{opening.pendingPlugins.join(" · ")}</dd></div> : null}
      </dl>
    </details>}
    <details id="request-trace-resources" className="request-trace-disclosure">
      <summary>
        <ChevronRight size={14} />{t("工具与连接", "Tools and connections")}
        <small>{t("观察到的工具", "Observed tools")} {row.observedTools.length} · MCP {servers.size}</small>
      </summary>
      {!tools.size && !servers.size && <p>{t("本次请求未记录工具或 MCP 连接。", "This request recorded no tools or MCP connections.")}</p>}
      <dl className="request-key-values">
        {row.connectionId && <div><dt>{t("连接 ID / 版本", "Connection ID / revision")}</dt><dd>{row.connectionId}{row.connectionRevision != null && ` / ${row.connectionRevision}`}</dd></div>}
        {sections.filter(([, values]) => values?.length).map(([label, values]) => <div key={label}><dt>{label}</dt><dd>{values?.join(" · ")}</dd></div>)}
      </dl>
      {row.mcp?.servers.length ? <>
        <h3>{t("绑定进程与握手", "Bound processes and handshakes")}</h3>
        <p>{t("计数为绑定进程的累计观测。", "Counters are lifetime observations of bound processes.")}</p>
        {row.mcp.servers.map(server => <section className="request-mcp-server" key={server.name}>
          <strong>{server.name}</strong>
          {!server.processes.length && <p>{t("尚未观测到进程", "No process observed")}</p>}
          {server.processes.map((process, index) => <dl className="request-key-values" key={process.pid ?? index}>
            <div><dt>PID</dt><dd>{process.pid ?? "—"} · {process.reused ? t("复用", "Reused") : t("新建", "Created")}{process.shared && ` · ${t("共享", "Shared")}`}</dd></div>
            <div><dt>{t("客户端连接", "Client connections")}</dt><dd>{process.connections}</dd></div>
            <div><dt>{t("初始化 / 握手缓存命中", "Initializations / handshake cache hits")}</dt><dd>{process.initializations} / {process.handshakeHits}</dd></div>
            {process.initializeMs != null && <div><dt>{t("最近成功握手", "Last successful handshake")}</dt><dd>{ms(process.initializeMs)}</dd></div>}
          </dl>)}
        </section>)}
      </> : null}
      <div className="session-tools-inventory-actions">
        {row.connectionId && <Link to={`/settings?section=accounts&connection=${encodeURIComponent(row.connectionId)}`}>{t("连接配置", "Connection settings")}<ArrowUpRight size={13} /></Link>}
        <Link to="/settings?section=mcp">MCP<ArrowUpRight size={13} /></Link>
        <Link to="/settings?section=skills">Skills<ArrowUpRight size={13} /></Link>
      </div>
    </details>
  </>;
}
