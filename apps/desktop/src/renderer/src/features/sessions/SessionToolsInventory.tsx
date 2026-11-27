import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  Info,
  Layers,
  RefreshCw,
  Search,
  Server,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import type { SessionToolInventory } from "@agenthub/schemas";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { useSessionsStore } from "../../stores/sessions";
import "./session-tools-inventory.css";

type EvidenceFilter = "all" | "observed" | "native" | "supplied";

function looksLikeShellCommand(name: string): boolean {
  return name.length > 42 || /[|;{}\n]/.test(name) || /^(?:Get-|Write-|Select-|git\s|npm\s|pnpm\s|cargo\s|pwsh|bash|cmd)/i.test(name);
}

export function SessionToolsInventory({
  sessionId,
}: {
  sessionId: string;
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const [result, setResult] = useState<SessionToolInventory>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<EvidenceFilter>("all");
  const [copiedKey, setCopiedKey] = useState("");
  const version = useRef(0);

  const identity = useSessionsStore(state => {
    const session = state.sessions.find(item => item.id === sessionId);
    return JSON.stringify([sessionId, session?.target, session?.connectionId, session?.connectionRevision]);
  });

  const load = useCallback(async () => {
    const current = ++version.current;
    setBusy(true);
    setError("");
    try {
      const next = await requestCore<SessionToolInventory>("session.tools", {
        sessionId,
      });
      if (current === version.current) setResult(next);
    } catch (e) {
      if (current === version.current) setError(String(e));
    } finally {
      if (current === version.current) setBusy(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setResult(undefined);
    void load();
    return () => { version.current++; };
  }, [identity, load]);

  useEffect(() => {
    if (!copiedKey) return;
    const timer = window.setTimeout(() => setCopiedKey(""), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedKey]);

  const copyValue = (key: string, value: string): void => {
    void navigator.clipboard.writeText(value).then(() => setCopiedKey(key)).catch(() => {});
  };

  const labels: Record<"native" | "observed" | "supplied", string> = {
    native: zh ? "原生报告" : "Native",
    observed: zh ? "已调用" : "Observed",
    supplied: zh ? "已传入" : "Supplied",
  };

  const counts = useMemo(() => {
    const tools = result?.tools ?? [];
    return {
      all: tools.length,
      observed: tools.filter(item => item.evidence === "observed").length,
      native: tools.filter(item => item.evidence === "native").length,
      supplied: tools.filter(item => item.evidence === "supplied").length,
    };
  }, [result]);

  const needle = query.trim().toLowerCase();
  const filteredTools = useMemo(() => {
    return (result?.tools ?? []).filter(tool => {
      if (filter !== "all" && tool.evidence !== filter) return false;
      if (!needle) return true;
      return tool.name.toLowerCase().includes(needle);
    });
  }, [result, filter, needle]);

  const filteredServers = useMemo(() => {
    return (result?.servers ?? []).filter(server => {
      if (!needle) return true;
      return `${server.name} ${server.status ?? ""}`.toLowerCase().includes(needle);
    });
  }, [result, needle]);

  const observedTools = filteredTools.filter(tool => tool.evidence === "observed");
  const registeredTools = filteredTools.filter(tool => tool.evidence !== "observed");

  return (
    <section className="sti-root" aria-label={zh ? "本次会话工具" : "Session tools"}>
      <div className="sti-topbar">
        <div className="sti-meta-strip">
          {result?.requestId && (
            <span className="sti-meta-chip" title={result.requestId}>
              <span>{zh ? "请求" : "Req"}</span>
              <code>{result.requestId.slice(0, 8)}</code>
            </span>
          )}
          {result?.connectionRevision !== undefined && (
            <span className="sti-meta-chip">
              <span>{zh ? "版本" : "Rev"}</span>
              <code>v{result.connectionRevision}</code>
            </span>
          )}
        </div>
        <div className="sti-top-actions">
          <button type="button" className="sti-btn" disabled={busy} onClick={() => void load()}>
            <RefreshCw size={12} className={busy ? "animate-spin" : undefined} aria-hidden />
            {zh ? "刷新" : "Refresh"}
          </button>
          <Link className="sti-btn" to={`/settings?section=usage&tab=requests&session=${sessionId}`}>
            {zh ? "请求日志" : "Logs"}
            <ArrowUpRight size={12} aria-hidden />
          </Link>
        </div>
      </div>

      <div className="sti-kpi-strip" role="group" aria-label={zh ? "按证据状态筛选" : "Filter by evidence"}>
        {([
          { id: "all", label: zh ? "全部" : "All", count: counts.all, tone: "neutral" },
          { id: "observed", label: zh ? "已调用" : "Observed", count: counts.observed, tone: "ok" },
          { id: "native", label: zh ? "原生" : "Native", count: counts.native, tone: "blue" },
          { id: "supplied", label: zh ? "已传入" : "Supplied", count: counts.supplied, tone: "muted" },
        ] as const).map(item => (
          <button
            key={item.id}
            type="button"
            className="sti-kpi-pill"
            data-tone={item.tone}
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            <strong>{item.count}</strong>
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      <div className="sti-search">
        <Search size={13} aria-hidden />
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={zh ? "搜索工具名、命令或 MCP 服务…" : "Filter tools, commands or MCP servers…"}
          aria-label={zh ? "搜索工具" : "Filter tools"}
        />
        {query && (
          <button type="button" onClick={() => setQuery("")} aria-label={zh ? "清空" : "Clear"}>
            <X size={12} aria-hidden />
          </button>
        )}
      </div>

      <div className="sti-scroll">
        {error && <p role="alert" className="sti-alert sti-alert-error">{error}</p>}

        {result && !result.nativeReported && (
          <div className="sti-alert sti-alert-info">
            <Info size={13} aria-hidden />
            <span>{zh ? "此 Harness 未上报完整工具清单，以下基于本次会话已传入与实际调用的证据汇总。" : "This harness did not report a full tool manifest; showing supplied and observed evidence."}</span>
          </div>
        )}

        {busy && !result && (
          <p className="sti-empty">{zh ? "正在读取工具记录…" : "Loading tool inventory…"}</p>
        )}

        {observedTools.length > 0 && (
          <div className="sti-group">
            <h3 className="sti-group-title">
              <i className="sti-dot" data-tone="ok" aria-hidden />
              {zh ? "已实际调用" : "Observed in session"}
              <span>{observedTools.length}</span>
            </h3>
            <ul className="sti-list">
              {observedTools.map(tool => {
                const isCmd = looksLikeShellCommand(tool.name);
                const key = `obs:${tool.name}`;
                return (
                  <li key={key} className="sti-card" data-cmd={isCmd || undefined}>
                    <span className="sti-card-icon" data-tone="ok" aria-hidden>
                      {isCmd ? <Terminal size={12} /> : <Wrench size={12} />}
                    </span>
                    <div className="sti-card-body">
                      <code title={tool.name}>{tool.name}</code>
                      <span className="sti-card-tag" data-tone="ok">{labels[tool.evidence]}</span>
                    </div>
                    <button
                      type="button"
                      className="sti-copy-btn"
                      data-copied={copiedKey === key || undefined}
                      onClick={() => copyValue(key, tool.name)}
                      title={copiedKey === key ? (zh ? "已复制" : "Copied") : (zh ? "复制" : "Copy")}
                    >
                      {copiedKey === key ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {filteredServers.length > 0 && (
          <div className="sti-group">
            <h3 className="sti-group-title">
              <Server size={12} aria-hidden />
              {zh ? "MCP 服务" : "MCP servers"}
              <span>{filteredServers.length}</span>
            </h3>
            <ul className="sti-list">
              {filteredServers.map(server => {
                const key = `srv:${server.name}`;
                return (
                  <li key={key} className="sti-card">
                    <span className="sti-card-icon" data-tone="blue" aria-hidden>
                      <Server size={12} />
                    </span>
                    <div className="sti-card-body">
                      <code title={server.name}>{server.name}</code>
                      <span className="sti-card-tag">
                        {server.status || labels[server.evidence]}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {registeredTools.length > 0 && (
          <div className="sti-group">
            <h3 className="sti-group-title">
              <Layers size={12} aria-hidden />
              {zh ? "已传入 / 声明工具" : "Supplied & declared tools"}
              <span>{registeredTools.length}</span>
            </h3>
            <ul className="sti-list">
              {registeredTools.map(tool => {
                const key = `reg:${tool.name}`;
                const tone = tool.evidence === "native" ? "blue" : "muted";
                return (
                  <li key={key} className="sti-card">
                    <span className="sti-card-icon" data-tone={tone} aria-hidden>
                      <Wrench size={12} />
                    </span>
                    <div className="sti-card-body">
                      <code title={tool.name}>{tool.name}</code>
                      <span className="sti-card-tag" data-tone={tone}>
                        {tool.evidence === "supplied" ? (zh ? "已传入 · 未确认加载" : "Supplied") : labels[tool.evidence]}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="sti-copy-btn"
                      data-copied={copiedKey === key || undefined}
                      onClick={() => copyValue(key, tool.name)}
                      title={copiedKey === key ? (zh ? "已复制" : "Copied") : (zh ? "复制名称" : "Copy name")}
                    >
                      {copiedKey === key ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {result && !filteredTools.length && !filteredServers.length && (
          <p className="sti-empty">
            {query || filter !== "all"
              ? (zh ? "没有匹配的工具记录" : "No matching tools")
              : (zh ? "本次会话暂无工具记录" : "No tools recorded yet")}
          </p>
        )}
      </div>

      <footer className="sti-footer">
        {result?.connectionId && (
          <Link className="sti-footer-link" to={`/settings?section=accounts&connection=${encodeURIComponent(result.connectionId)}`}>
            {zh ? "检查连接" : "Connection"}<ArrowUpRight size={11} aria-hidden />
          </Link>
        )}
        <Link className="sti-footer-link" to="/settings?section=mcp">
          MCP<ArrowUpRight size={11} aria-hidden />
        </Link>
        <Link className="sti-footer-link" to="/settings?section=skills">
          Skills<ArrowUpRight size={11} aria-hidden />
        </Link>
      </footer>
    </section>
  );
}
