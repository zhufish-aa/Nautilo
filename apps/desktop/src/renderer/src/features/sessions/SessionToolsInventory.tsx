import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, RefreshCw, Wrench } from "lucide-react";
import { Link } from "react-router-dom";
import type { SessionToolInventory } from "@agenthub/schemas";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import "../settings/request-logs.css";

export function SessionToolsInventory({
  sessionId,
}: {
  sessionId: string;
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN",
    [result, setResult] = useState<SessionToolInventory>(),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const version = useRef(0);
  useEffect(() => {
    version.current++;
    setResult(undefined);
    setError("");
    setOpen(false);
    setBusy(false);
  }, [sessionId]);
  const load = async () => {
    const current = ++version.current;
    setBusy(true);
    setOpen(true);
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
  };
  const labels = {
    native: zh ? "原生报告" : "Native reported",
    observed: zh ? "已实际调用" : "Observed",
    supplied: zh ? "已传入，未确认加载" : "Supplied, load unconfirmed",
  };
  return (
    <section className="session-tools-inventory">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : void load())}
      >
        <Wrench size={15} />
        {zh ? "本次会话工具" : "Session tools"}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div>
          <div className="session-tools-inventory-actions">
            <button type="button" disabled={busy} onClick={() => void load()}>
              <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
              {zh ? "刷新记录" : "Refresh evidence"}
            </button>
            <Link
              to={`/settings?section=usage&tab=requests&session=${sessionId}`}
            >
              {zh ? "请求日志" : "Request logs"}
              <ArrowUpRight size={13} />
            </Link>
          </div>
          {error && <p role="alert">{error}</p>}
          {result && !result.nativeReported && (
            <p>
              {zh
                ? "此 Harness 尚未报告完整工具清单。"
                : "This harness has not reported a complete tool list."}
            </p>
          )}
          {result?.tools.map((tool) => (
            <div className="session-tool-evidence" key={tool.name}>
              <strong>{tool.name}</strong>
              <span>{labels[tool.evidence]}</span>
            </div>
          ))}
          {result?.servers.map((server) => (
            <div
              className="session-tool-evidence"
              key={`server:${server.name}`}
            >
              <strong>{server.name}</strong>
              <span>{server.status || labels[server.evidence]}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
