import { useEffect, useId, useRef, useState } from "react";
import type { RemoteRelayCatalog, RemoteRelayNode } from "@agenthub/schemas";
import { Check, ChevronDown, Globe2, Plus, RefreshCw, Server, X } from "lucide-react";
import { requestCore } from "../../../lib/bridge";
import { Button } from "../../../components/ui/Button";
import { relayAddressKey, relayRegion, relaySelection } from "./relay-catalog";
import "./relay-node-select.css";

const catalogs = new Map<string, RemoteRelayCatalog>();
const pending = new Map<string, Promise<RemoteRelayCatalog>>();
let automaticProbeStarted = false;

function loadCatalog(key: string, refresh: boolean): Promise<RemoteRelayCatalog> {
  const requestKey = `${key}:${refresh}`;
  const current = pending.get(requestKey);
  if (current) return current;
  const promise = requestCore<RemoteRelayCatalog>("remote.relays", { urls: JSON.parse(key), refresh }).then(result => {
    if (catalogs.size >= 8) catalogs.delete(catalogs.keys().next().value!);
    catalogs.set(key, result);
    return result;
  }).finally(() => pending.delete(requestKey));
  pending.set(requestKey, promise);
  return promise;
}

export function useRelayCatalog(urls: string[] | undefined) {
  const validUrls = urls?.map(relayAddressKey).filter(value => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }).slice(0, 4);
  const key = validUrls && JSON.stringify(validUrls);
  const [catalog, setCatalog] = useState<RemoteRelayCatalog>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  useEffect(() => {
    const version = ++requestVersion.current;
    setError("");
    if (!key) {
      setCatalog(undefined);
      setLoading(false);
      return;
    }
    setCatalog(catalogs.get(key));
    setLoading(true);
    void (async () => {
      try {
        const value = catalogs.get(key) ?? await loadCatalog(key, false);
        if (version !== requestVersion.current) return;
        setCatalog(value);
        const shouldMeasure = !automaticProbeStarted && value.nodes.some(node => !node.measuredAt);
        automaticProbeStarted = true;
        if (shouldMeasure) {
          const measured = await loadCatalog(key, true);
          if (version === requestVersion.current) setCatalog(measured);
        }
      } catch (cause) { if (version === requestVersion.current) setError(String(cause)); }
      finally { if (version === requestVersion.current) setLoading(false); }
    })();
    return () => { requestVersion.current += 1; };
  }, [key]);
  const refresh = async () => {
    if (!key || loading) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError("");
    try {
      const value = await loadCatalog(key, true);
      if (version === requestVersion.current) setCatalog(value);
    } catch (cause) { if (version === requestVersion.current) setError(String(cause)); }
    finally { if (version === requestVersion.current) setLoading(false); }
  };
  return { nodes: catalog?.nodes ?? [], loading, error, refresh };
}

export function RelayLatency({ latencyMs, error, loading, zh }: Pick<RemoteRelayNode, "latencyMs" | "error"> & { loading?: boolean; zh: boolean }) {
  const quality = latencyMs === undefined ? "unknown" : latencyMs < 80 ? "good" : latencyMs <= 200 ? "normal" : "high";
  return <span className="relay-latency" data-quality={quality} data-loading={loading || undefined}
    title={error || (zh ? "电脑到节点的 HTTPS 往返时间" : "PC-to-node HTTPS round-trip time")}>
    <span className="relay-signal" aria-hidden><i /><i /><i /></span>
    {latencyMs !== undefined ? `${latencyMs} ms` : error ? (zh ? "无法测速" : "Probe failed") : "—"}
  </span>;
}

export function RelayNodeSelect({ urls, zh, disabled, onChange, measurements }: {
  urls: string[];
  zh: boolean;
  disabled: boolean;
  onChange(urls: string[]): void;
  measurements: ReturnType<typeof useRelayCatalog>;
}) {
  const { nodes, loading, error, refresh } = measurements;
  const [custom, setCustom] = useState(false);
  const id = useId();
  const details = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const value = custom ? "custom" : relaySelection(urls, nodes);
  const selected = nodes.find(node => node.id === value);
  const customLabel = zh ? "自建中继" : "Self-hosted relay";
  const publicLabel = zh ? "公共节点 · 自动选择" : "Public relays · automatic";
  const addresses = urls.length ? urls : [""];
  const close = () => {
    if (details.current) details.current.open = false;
    trigger.current?.focus();
  };
  const change = (next: string) => {
    setCustom(next === "custom");
    if (next === "public-auto") onChange([]);
    else if (next !== "custom") {
      const node = nodes.find(item => item.id === next);
      if (node) onChange([node.url]);
    }
    close();
  };
  const options = [
    { id: "public-auto", name: publicLabel, node: undefined },
    ...nodes.filter(node => node.source === "public").map(node => ({ id: node.id, name: relayRegion(node, zh), node })),
    { id: "custom", name: customLabel, node: undefined },
  ];

  return <div className="relay-picker">
    <div className="relay-picker-label">
      <div><strong>{zh ? "中继节点" : "Relay node"}</strong><span>{zh ? "电脑 → 节点 · HTTPS" : "PC → relay · HTTPS"}</span></div>
      <Button size="sm" variant="outline" className="relay-probe-button" disabled={loading || disabled} onClick={() => void refresh()} aria-busy={loading}>
        <RefreshCw size={13} aria-hidden />{zh ? "重新测速" : "Retest latency"}
      </Button>
    </div>

    <details className="relay-picker-panel" ref={details} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    }} onKeyDown={event => {
      if (event.key === "Escape" && details.current?.open) {
        event.stopPropagation();
        close();
      }
    }}>
      <summary ref={trigger} className="relay-picker-trigger" aria-disabled={disabled} onClick={event => {
        if (disabled) event.preventDefault();
      }}>
        {value === "custom" ? <Server size={15} aria-hidden /> : <Globe2 size={15} aria-hidden />}
        <span className="relay-trigger-name">{selected ? relayRegion(selected, zh) : value === "custom" ? customLabel : publicLabel}</span>
        {selected && <RelayLatency {...selected} loading={loading} zh={zh} />}
        <ChevronDown size={14} className="relay-chevron" aria-hidden />
      </summary>
      <div className="relay-picker-menu" role="group" aria-label={zh ? "选择中继节点" : "Choose relay node"}>
        {options.map(({ id: optionId, name, node }) => <button type="button" key={optionId} className="relay-picker-item"
          aria-pressed={optionId === value} disabled={disabled} onClick={() => change(optionId)}>
          {optionId === "custom" ? <Server size={15} aria-hidden /> : <Globe2 size={15} aria-hidden />}
          <span className="relay-node-copy"><span>{name}</span>{node && <small>{new URL(node.url).hostname}</small>}</span>
          {node && <RelayLatency {...node} loading={loading} zh={zh} />}
          {optionId === value && <Check size={14} className="relay-check" aria-hidden />}
        </button>)}
      </div>
    </details>

    {value === "custom" && <div className="relay-custom-urls">
      <label htmlFor={`${id}-0`}>{zh ? "服务器地址" : "Server URL"}</label>
      {addresses.map((url, index) => {
        const node = nodes.find(item => relayAddressKey(item.url) === relayAddressKey(url));
        return <div className="relay-custom-row" key={index}>
          <div className="relay-address-field">
            <input id={`${id}-${index}`} aria-label={index ? (zh ? `服务器地址 ${index + 1}` : `Server URL ${index + 1}`) : undefined}
              value={url} placeholder="https://relay.example.com" spellCheck={false} disabled={disabled}
              onChange={event => onChange(addresses.map((item, i) => i === index ? event.target.value : item))} />
            <RelayLatency latencyMs={node?.latencyMs} error={node?.error} loading={loading && !!node} zh={zh} />
          </div>
          {index > 0 && <button type="button" className="remote-icon-button" aria-label={zh ? "移除此地址" : "Remove address"}
            disabled={disabled} onClick={() => onChange(addresses.filter((_, i) => i !== index))}><X size={14} aria-hidden /></button>}
        </div>;
      })}
      {addresses.length < 4 && <button type="button" className="relay-add-url" disabled={disabled || addresses.some(url => !url.trim())}
        onClick={() => onChange([...addresses, ""])}><Plus size={13} aria-hidden />{zh ? "添加备用地址" : "Add backup URL"}</button>}
    </div>}

    <div className="relay-picker-meta">
      {(loading || error) && <p role="status">{error ? (zh ? "测速未完成，可以重试。" : "Latency test failed. Try again.")
        : (zh ? "正在测量节点延迟…" : "Measuring relay latency…")}</p>}
      <details><summary>{zh ? "自部署要求" : "Self-hosting requirements"}</summary>
        <p>{zh ? "兼容 Iroh Relay 1.4.1、可访问的公网地址、TCP 443 与受信任的 HTTPS 证书。无域名时可使用公网 IP 证书。" : "Iroh Relay 1.4.1, a reachable public address, TCP 443 and a trusted HTTPS certificate. A public-IP certificate works without a domain."}</p>
      </details>
    </div>
  </div>;
}
