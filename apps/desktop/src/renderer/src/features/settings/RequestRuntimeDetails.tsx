import type { RequestLog } from "@agenthub/schemas";
import { ms } from "./request-log-display";

const reasons: Record<string, [string, string]> = {
  resident: ["同身份常驻连接", "Same resident identity"], first_use: ["首次使用", "First use"],
  configuration_changed: ["配置身份已变化", "Configuration identity changed"], session_changed: ["原生会话已变化", "Native session changed"],
  process_exited: ["原生进程已退出", "Native process exited"], transport_recovery: ["恢复原生传输", "Native transport recovery"],
  protocol_single_use: ["原生协议要求单次进程", "Protocol requires a single-use process"],
};
export function RequestRuntimeDetails({ row, zh }: { row: RequestLog; zh: boolean }): JSX.Element | null {
  if (!row.runtime && !row.mcp) return null;
  return <div className="request-runtime-details">
    {row.runtime && <div className="request-log-meta">
      {row.runtime.pid !== undefined && <span>PID {row.runtime.pid}</span>}
      {row.runtime.transport && <span>{row.runtime.transport}</span>}
      <span>{zh ? "复用 / 新建原因" : "Reuse / creation reason"} · {row.runtime.reason && reasons[row.runtime.reason]?.[zh ? 0 : 1] || "—"}</span>
    </div>}
    {row.mcp && <details className="request-log-tools">
      <summary>MCP · {zh ? "绑定进程与握手" : "Bound processes and handshakes"}</summary>
      <div className="request-mcp-grid">
        {row.mcp.servers.map(server => <section key={server.name}>
          <strong>{server.name}</strong>
          {server.processes.length === 0 && <span>{zh ? "尚未观测到进程" : "Process not yet observed"}</span>}
          {server.processes.map((process, index) => <dl key={process.pid ?? index}>
            <dt>PID</dt><dd>{process.pid ?? "—"} · {process.reused ? (zh ? "复用" : "Reused") : (zh ? "新建" : "Created")}</dd>
            <dt>{zh ? "客户端连接" : "Client connections"}</dt><dd>{process.connections}</dd>
            <dt>{zh ? "初始化 / 缓存命中" : "Initializations / cache hits"}</dt><dd>{process.initializations} / {process.handshakeHits}</dd>
            <dt>{zh ? "最近成功握手" : "Last successful handshake"}</dt><dd>{ms(process.initializeMs ?? undefined)}</dd>
          </dl>)}
        </section>)}
      </div>
      <p>{zh ? "此请求绑定进程的累计计数；不作为并发请求的单轮增量。" : "Lifetime counters of this request's bound processes, not per-turn deltas of concurrent requests."}</p>
    </details>}
  </div>;
}
